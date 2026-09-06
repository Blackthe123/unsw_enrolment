import 'dotenv/config';
import express from 'express';
import webpush from 'web-push';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import axios from 'axios';
import * as cheerio from 'cheerio';

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
  CREATE TABLE IF NOT EXISTS timetable_cache (
    course_code TEXT NOT NULL,
    term TEXT NOT NULL,
    classes_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (course_code, term)
  )
`);

const getCachedClasses = db.prepare(`
  SELECT classes_json, updated_at FROM timetable_cache 
  WHERE course_code = ? AND term = ? 
  AND updated_at > datetime('now', '-24 hours')
`);

const saveCachedClasses = db.prepare(`
  INSERT INTO timetable_cache (course_code, term, classes_json, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(course_code, term) DO UPDATE SET
    classes_json = excluded.classes_json,
    updated_at = CURRENT_TIMESTAMP
`);

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

const getStats = db.prepare(`
  SELECT 
    COUNT(DISTINCT endpoint) AS total_users,
    COUNT(DISTINCT course_code) AS unique_courses,
    COUNT(*) AS total_watches
  FROM watches
`);

// --- Express App Setup ---
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: PUBLIC_VAPID_KEY });
});

app.get('/api/stats', (req, res) => {
  try {
    const stats = getStats.get();
    res.json({
      totalUsers: stats.total_users || 0,
      uniqueCourses: stats.unique_courses || 0,
      totalWatches: stats.total_watches || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// API Route for Frontend to fetch classes
app.get('/api/classes/:course/:term', async (req, res) => {
  const { course, term } = req.params;
  const courseUpper = course.toUpperCase().trim();

  // Check 24-hour cache first (Response in <2ms!)
  const cached = getCachedClasses.get(courseUpper, term);
  if (cached) {
    return res.json(JSON.parse(cached.classes_json));
  }

  // Scrape if not in cache
  const classes = await scrapeUNSWTimetable(courseUpper, term);
  if (classes.length > 0) {
    saveCachedClasses.run(courseUpper, term, JSON.stringify(classes));
  }
  res.json(classes);
});

// Discord Alert
async function sendAdminAlert(message) {
  if (!process.env.DISCORD_ADMIN_WEBHOOK) return;
  try {
    await fetch(process.env.DISCORD_ADMIN_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    });
  } catch (err) {
    console.error('Failed to send admin webhook:', err.message);
  }
}

// UNSW Public Timetable Scraper
async function scrapeUNSWTimetable(courseCode, term) {
  try {
    const url = `https://timetable.unsw.edu.au/current/${courseCode.toUpperCase()}.html`;
    const { data: html } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 8000
    });

    const $ = cheerio.load(html);
    const classes = [];

    // Loop through each class detail card
    $('td.formBody td.formBody').each((_, box) => {
      const $box = $(box);
      const firstLabel = $box.find('td.label').first().text().trim();

      if (firstLabel === 'Class Nbr') {
        const dataMap = {};
        const labels = $box.find('td.label').map((_, el) => $(el).text().replace(/\u00a0/g, '').trim()).get();
        const values = $box.find('td.data').map((_, el) => $(el).text().replace(/\u00a0/g, '').trim()).get();

        labels.forEach((label, i) => {
          dataMap[label] = values[i] || '';
        });

        const teachingPeriod = dataMap['Teaching Period'] || '';

        // Filter for requested term (e.g. "T3")
        if (!term || teachingPeriod.toUpperCase().includes(term.toUpperCase())) {
          
          // --- Extract Meeting Information (RowHighlight / RowLowlight) ---
          const meetingTimes = [];
          const meetingLocations = [];

          $box.find('tr.rowHighlight, tr.rowLowlight').each((_, mRow) => {
            const cells = $(mRow).find('td.data');
            if (cells.length >= 3) {
              const day = cells.eq(0).text().trim();
              const time = cells.eq(1).text().trim();
              const loc = cells.eq(2).text().trim();

              if (day && time) {
                meetingTimes.push(`${day} ${time}`);
              }
              if (loc && loc !== '-' && !meetingLocations.includes(loc)) {
                meetingLocations.push(loc);
              }
            }
          });

          classes.push({
            classNbr: dataMap['Class Nbr'],
            section: dataMap['Section'],
            activity: dataMap['Activity'], // e.g. "Lecture", "Tutorial-Laboratory"
            mode: dataMap['Mode of Delivery'] || '',
            teachingPeriod: teachingPeriod,
            times: meetingTimes.join(', '),        // e.g. "Mon 11:00 - 13:00, Tue 16:00 - 18:00"
            location: meetingLocations.join(' & ') // e.g. "Science & Engineering G05 (K-E8-G05)"
          });
        }
      }
    });

    return classes;
  } catch (err) {
    console.error(`Timetable scrape error for ${courseCode}:`, err.message);
    return [];
  }
}


// --- Playwright Polling Worker ---
async function pollCourses() {
  const uniqueTargets = getUniqueCourses.all();
  if (uniqueTargets.length === 0) return;

  if (!fs.existsSync('auth.json')) {
    console.error('❌ No auth.json found! Run "node login.js" first.');
    return;
  }

  if (page.url().includes('login.microsoftonline.com') || page.url().includes('/login')) {
    console.error('🚨 [AUTH EXPIRED] Your session in auth.json has expired!');
    sendAdminAlert('🚨 **UNSW Tracker Alert:** myUNSW session in `auth.json` has expired! Please log in to refresh.');
    return;
  }


  console.log(`\n🔍 Checking ${uniqueTargets.length} unique course(s) on myUNSW...`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
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