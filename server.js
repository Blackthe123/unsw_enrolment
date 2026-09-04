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

  CREATE TABLE IF NOT EXISTS class_capacities (
    course_code TEXT NOT NULL,
    class_id TEXT NOT NULL,
    term TEXT NOT NULL,
    component TEXT,
    enrolled INTEGER,
    capacity INTEGER,
    status TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (course_code, class_id, term)
  );
`);

// DB Prepared Queries
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

// in server.js
const getWatchesWithCapacities = db.prepare(`
  SELECT 
    w.id AS watch_id, 
    w.course_code, 
    w.class_id AS watched_class_id, 
    w.class_label, 
    w.term,
    c.class_id AS actual_class_id,
    c.component,
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

const upsertCapacity = db.prepare(`
  INSERT INTO class_capacities (course_code, class_id, term, component, enrolled, capacity, status, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(course_code, class_id, term) DO UPDATE SET
    component = excluded.component,
    enrolled = excluded.enrolled,
    capacity = excluded.capacity,
    status = excluded.status,
    updated_at = CURRENT_TIMESTAMP
`);

// --- Express App Setup ---
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: PUBLIC_VAPID_KEY });
});

// Smart Track endpoint (Handles ALL vs Specific deduplication)
app.post('/api/track', (req, res) => {
  const { courseCode, classId, classLabel, term, subscription } = req.body;
  const course = courseCode.toUpperCase().trim();
  const endpoint = subscription.endpoint;

  try {
    // 1. If user is already tracking ALL for this course, reject specific class addition
    const hasAll = checkExistingAllWatch.get(endpoint, course, term);
    if (hasAll && classId !== 'ALL') {
      return res.json({ success: true, message: `Already tracking ALL classes for ${course}` });
    }

    // 2. If user selects ALL, remove any individual classes they had previously added
    if (classId === 'ALL') {
      deleteSpecificWatches.run(endpoint, course, term);
    }

    // 3. Insert the watch
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
    console.error('Failed to save watch:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetch watches with live capacities for calling device
app.post('/api/my-watches', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.json([]);
  
  try {
    const watches = getWatchesWithCapacities.all(endpoint);
    res.json(watches);
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

const getPreviousClassState = db.prepare(`
  SELECT enrolled, capacity, status FROM class_capacities 
  WHERE course_code = ? AND class_id = ? AND term = ?
`);

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

      // 1. Switch to Term Tab
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

      // 2. CHECK OVERALL COURSE CAPACITY FIRST (The Gatekeeper)
      let isOverallCourseOpen = true;
      try {
        const overallCapElem = page.locator('dl dt:has-text("Enrols / Capacity") + dd').first();
        const overallText = (await overallCapElem.innerText()).trim(); // e.g. "167 / 168"
        const [cEnrolled, cMax] = overallText.split('/').map(n => parseInt(n.trim(), 10));

        console.log(`📊 Overall ${course} Capacity: ${cEnrolled} / ${cMax}`);
        
        if (cEnrolled >= cMax) {
          isOverallCourseOpen = false;
          console.log(`⛔ ${course} is FULL overall (${cEnrolled}/${cMax}). Class alerts suppressed.`);
        }
      } catch (err) {
        console.warn('Could not parse overall course capacity, checking classes directly...');
      }

      // 3. Parse Individual Class Rows
      const rows = page.locator('section.un-page-section table.table tbody tr');
      const count = await rows.count();

      for (let i = 0; i < count; i++) {
        const cells = rows.nth(i).locator('td');
        if ((await cells.count()) < 11) continue;

        const classNbr = (await cells.nth(0).innerText()).trim();
        const component = (await cells.nth(2).innerText()).trim();
        const capacityText = (await cells.nth(9).innerText()).trim(); // "227 / 260"
        const status = (await cells.nth(10).innerText()).trim();      // "Open" / "Closed"
        const [enrolled, max] = capacityText.split('/').map(n => parseInt(n.trim(), 10));

        // Check previous recorded state from DB to prevent spamming
        const prevState = getPreviousClassState.get(course, classNbr, term);
        const wasFullOrClosed = !prevState || prevState.enrolled >= prevState.capacity || prevState.status === 'Closed';
        const moreSpotsOpened = prevState && enrolled < prevState.enrolled;

        // Save current numbers to database so the PWA UI is always up to date
        upsertCapacity.run(course, classNbr, term, component, enrolled, max, status);

        // Send alert ONLY IF:
        // 1. Overall course has spots (isOverallCourseOpen === true)
        // 2. This specific class has spots (enrolled < max)
        // 3. State changed (it was previously full, or more spots opened)
        const shouldNotify = isOverallCourseOpen && (enrolled < max) && (wasFullOrClosed || moreSpotsOpened);

        if (shouldNotify) {
          console.log(`🎉 NEW SPOT OPEN: ${course} Class #${classNbr} [${component}] (${enrolled}/${max})`);

          const subscribers = getSubscribersForClass.all(course, term, classNbr);

          for (const sub of subscribers) {
            const pushSub = JSON.parse(sub.subscription);
            
            const payload = JSON.stringify({
              title: `Spot Available in ${course}!`,
              body: `Class #${classNbr} [${component}] now has open seats (${enrolled}/${max}). Tap to enrol!`,
              url: 'https://my.unsw.edu.au'
            });

            webpush.sendNotification(pushSub, payload)
              .then(() => console.log(`🚀 [Push Sent] Alerted subscriber for ${course} #${classNbr}`))
              .catch(err => {
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