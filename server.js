import 'dotenv/config';
import express from 'express';
import webpush from 'web-push';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const { 
  VAPID_MAILTO, 
  PUBLIC_VAPID_KEY, 
  PRIVATE_VAPID_KEY, 
  PORT = 3000 
} = process.env;

if (!VAPID_MAILTO || !PUBLIC_VAPID_KEY || !PRIVATE_VAPID_KEY) {
  console.error('❌ Missing VAPID configuration in .env file!');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_MAILTO, PUBLIC_VAPID_KEY, PRIVATE_VAPID_KEY);

// --- SQLite Database Setup ---
const db = new Database('watches.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_code TEXT NOT NULL,
    class_id TEXT NOT NULL,
    class_label TEXT,
    term TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    subscription TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(endpoint, course_code, class_id, term)
  );

  CREATE TABLE IF NOT EXISTS course_capacities (
    course_code TEXT NOT NULL,
    term TEXT NOT NULL,
    enrolled INTEGER,
    capacity INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (course_code, term)
  );

  CREATE TABLE IF NOT EXISTS class_capacities (
    course_code TEXT NOT NULL,
    class_id TEXT NOT NULL,
    term TEXT NOT NULL,
    component TEXT,
    day TEXT,
    time TEXT,
    location TEXT,
    enrolled INTEGER,
    capacity INTEGER,
    status TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (course_code, class_id, term)
  );
`);

// Prepared Statements
const checkExistingAllWatch = db.prepare(`
  SELECT id FROM watches WHERE endpoint = ? AND course_code = ? AND term = ? AND class_id = 'ALL'
`);

const deleteSpecificWatches = db.prepare(`
  DELETE FROM watches WHERE endpoint = ? AND course_code = ? AND term = ? AND class_id != 'ALL'
`);

const insertWatch = db.prepare(`
  INSERT OR IGNORE INTO watches (course_code, class_id, class_label, term, endpoint, subscription)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const deleteWatch = db.prepare(`
  DELETE FROM watches WHERE id = ? AND endpoint = ?
`);

const getUniqueCourses = db.prepare(`
  SELECT DISTINCT course_code, term FROM watches
`);

const getSubscribersForClass = db.prepare(`
  SELECT id, subscription, endpoint FROM watches 
  WHERE course_code = ? AND term = ? AND (class_id = 'ALL' OR class_id = ?)
`);

const getWatchesWithCapacities = db.prepare(`
  SELECT 
    w.id AS watch_id, 
    w.course_code, 
    w.class_id AS watched_class_id, 
    w.class_label, 
    w.term,
    c.class_id AS actual_class_id,
    c.component,
    c.day,
    c.time,
    c.location,
    c.enrolled,
    c.capacity,
    c.status
  FROM watches w
  LEFT JOIN class_capacities c 
    ON w.course_code = c.course_code 
    AND w.term = c.term 
    AND (w.class_id = c.class_id OR w.class_id = 'ALL')
  WHERE w.endpoint = ?
  ORDER BY w.created_at DESC, c.class_id ASC
`);

const getCourseCapacitiesForEndpoint = db.prepare(`
  SELECT DISTINCT 
    w.course_code, 
    w.term, 
    cc.enrolled, 
    cc.capacity, 
    cc.updated_at
  FROM watches w
  LEFT JOIN course_capacities cc 
    ON w.course_code = cc.course_code AND w.term = cc.term
  WHERE w.endpoint = ?
`);

const upsertCourseCapacity = db.prepare(`
  INSERT INTO course_capacities (course_code, term, enrolled, capacity, updated_at)
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(course_code, term) DO UPDATE SET
    enrolled = excluded.enrolled,
    capacity = excluded.capacity,
    updated_at = CURRENT_TIMESTAMP
`);

const upsertClassCapacity = db.prepare(`
  INSERT INTO class_capacities (course_code, class_id, term, component, day, time, location, enrolled, capacity, status, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(course_code, class_id, term) DO UPDATE SET
    component = excluded.component,
    day = excluded.day,
    time = excluded.time,
    location = excluded.location,
    enrolled = excluded.enrolled,
    capacity = excluded.capacity,
    status = excluded.status,
    updated_at = CURRENT_TIMESTAMP
`);

const getPreviousClassState = db.prepare(`
  SELECT enrolled, capacity, status FROM class_capacities 
  WHERE course_code = ? AND class_id = ? AND term = ?
`);

// --- Express App Setup ---
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: PUBLIC_VAPID_KEY });
});

app.post('/api/track', (req, res) => {
  const { courseCode, classId, classLabel, term, subscription } = req.body;
  const course = courseCode.toUpperCase().trim();
  const endpoint = subscription.endpoint;

  try {
    const hasAll = checkExistingAllWatch.get(endpoint, course, term);
    if (hasAll && classId !== 'ALL') {
      return res.json({ success: true, message: `Already tracking ALL classes for ${course}` });
    }

    if (classId === 'ALL') {
      deleteSpecificWatches.run(endpoint, course, term);
    }

    insertWatch.run(
      course,
      classId || 'ALL',
      classLabel || 'All Classes',
      term || 'T3',
      endpoint,
      JSON.stringify(subscription)
    );

    console.log(`📌 [Watch Added] ${course} (${classId}) for ${term}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch both specific watches and overall course summaries
app.post('/api/my-watches', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.json({ watches: [], courseCapacities: [] });
  
  try {
    const watches = getWatchesWithCapacities.all(endpoint);
    const courseCapacities = getCourseCapacitiesForEndpoint.all(endpoint);
    res.json({ watches, courseCapacities });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/untrack', (req, res) => {
  const { id, endpoint } = req.body;
  try {
    deleteWatch.run(id, endpoint);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Playwright Polling Worker ---
async function pollCourses() {
  const uniqueTargets = getUniqueCourses.all();
  if (uniqueTargets.length === 0) return;

  if (!fs.existsSync('auth.json')) {
    console.error('❌ No auth.json found! Run "node login.js" first.');
    return;
  }

  console.log(`\n🔍 Checking ${uniqueTargets.length} unique course(s) on myUNSW...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: 'auth.json' });
  const page = await context.newPage();

  try {
    await page.goto('https://my.unsw.edu.au/active/studentClassEnrol/courses.xml', { waitUntil: 'domcontentloaded' });

    if (page.url().includes('login.microsoftonline.com') || page.url().includes('/login')) {
      console.error('🚨 [AUTH EXPIRED] Your session in auth.json has expired!');
      return;
    }

    for (const target of uniqueTargets) {
      const { course_code: course, term } = target;

      if (!page.url().endsWith('courses.xml')) {
        await page.goto('https://my.unsw.edu.au/active/studentClassEnrol/courses.xml');
      }

      const termTabButton = page.locator(`ul.nav-tabs a:has-text("${term}")`).first();
      if (await termTabButton.count() > 0) {
        await termTabButton.click();
        await page.waitForTimeout(400);
      }

      const activeTab = page.locator('div.tab-pane.show.active');
      const courseRow = activeTab.locator(`table.table tbody tr:has-text("${course}")`).first();
      const isAlreadyInList = (await courseRow.count()) > 0;

      if (isAlreadyInList) {
        await courseRow.locator('button[name="bsdsSubmit-course-info"]').click();
      } else {
        const searchInput = activeTab.locator('input[name="search"]');
        const searchBtn = activeTab.locator('button[name="bsdsSubmit-search-courses"]');
        
        await searchInput.fill(course);
        await searchBtn.click();

        const searchResultRow = page.locator(`table.table tbody tr:has-text("${course}")`).first();
        await searchResultRow.waitFor({ timeout: 5000 });
        await searchResultRow.locator('button[name="bsdsSubmit-course-info"]').click();
      }

      await page.waitForSelector('h3.un-page-title:has-text("Course Information")');

      // 1. Parse & Save Overall Course Capacity (Ceiling)
      let isOverallCourseOpen = true;
      try {
        const overallCapElem = page.locator('dl dt:has-text("Enrols / Capacity") + dd').first();
        const overallText = (await overallCapElem.innerText()).trim();
        const [cEnrolled, cMax] = overallText.split('/').map(n => parseInt(n.trim(), 10));

        console.log(`📊 Overall ${course} Capacity: ${cEnrolled} / ${cMax}`);
        upsertCourseCapacity.run(course, term, cEnrolled, cMax);

        if (cEnrolled >= cMax) {
          isOverallCourseOpen = false;
          console.log(`⛔ ${course} is FULL overall (${cEnrolled}/${cMax}). Class alerts suppressed.`);
        }
      } catch (err) {
        console.warn('Could not parse overall course capacity');
      }

      // 2. Parse & Save Rich Class Component Information
      const rows = page.locator('section.un-page-section table.table tbody tr');
      const count = await rows.count();

      for (let i = 0; i < count; i++) {
        const cells = rows.nth(i).locator('td');
        if ((await cells.count()) < 11) continue;

        const classNbr = (await cells.nth(0).innerText()).trim();
        const component = (await cells.nth(2).innerText()).trim();
        const location = (await cells.nth(5).innerText()).trim();
        const day = (await cells.nth(6).innerText()).trim();
        const time = (await cells.nth(7).innerText()).trim();
        const capacityText = (await cells.nth(9).innerText()).trim();
        const status = (await cells.nth(10).innerText()).trim();
        const [enrolled, max] = capacityText.split('/').map(n => parseInt(n.trim(), 10));

        const prevState = getPreviousClassState.get(course, classNbr, term);
        const wasFullOrClosed = !prevState || prevState.enrolled >= prevState.capacity || prevState.status === 'Closed';
        const moreSpotsOpened = prevState && enrolled < prevState.enrolled;

        // Save detailed class metadata to DB
        upsertClassCapacity.run(course, classNbr, term, component, day, time, location, enrolled, max, status);

        const shouldNotify = isOverallCourseOpen && (enrolled < max) && (wasFullOrClosed || moreSpotsOpened);

        if (shouldNotify) {
          console.log(`🎉 SPOT OPEN: ${course} Class #${classNbr} [${component}] (${enrolled}/${max})`);

          const subscribers = getSubscribersForClass.all(course, term, classNbr);

          for (const sub of subscribers) {
            const pushSub = JSON.parse(sub.subscription);
            
            const payload = JSON.stringify({
              title: `Spot Available in ${course}!`,
              body: `Class #${classNbr} [${component}] (${day} ${time}) has seats open (${enrolled}/${max}). Tap to enrol!`,
              url: 'https://my.unsw.edu.au'
            });

            webpush.sendNotification(pushSub, payload).catch(err => {
              if (err.statusCode === 410 || err.statusCode === 404) {
                deleteWatch.run(sub.id, sub.endpoint);
              }
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Scraper error during poll:', error.message);
  } finally {
    await browser.close();
  }
}

setInterval(pollCourses, 120000);
setTimeout(pollCourses, 5000);

app.listen(PORT, () => console.log(`🚀 PWA Server running at http://localhost:${PORT}`));