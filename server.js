import express from 'express';
import webpush from 'web-push';
import { chromium } from 'playwright';
import fs from 'node:fs';
import 'dotenv/config';

const { VAPID_MAILTO, PUBLIC_VAPID_KEY, PRIVATE_VAPID_KEY } = process.env;

webpush.setVapidDetails(
  VAPID_MAILTO,
  PUBLIC_VAPID_KEY,
  PRIVATE_VAPID_KEY
);



const app = express();
app.use(express.json());
app.use(express.static('public'));

webpush.setVapidDetails(VAPID_MAILTO, PUBLIC_VAPID_KEY, PRIVATE_VAPID_KEY);

// In-memory watch list (or replace with SQLite)
let activeWatches = [];

app.post('/api/track', (req, res) => {
  const { courseCode, classId, term, subscription } = req.body;
  activeWatches.push({ courseCode, classId, term, subscription });
  console.log(`[Watch Added] ${courseCode} (${classId}) for ${term}`);
  res.json({ success: true });
});

app.get('/api/watches', (req, res) => {
  res.json(activeWatches.map(({ courseCode, classId, term }) => ({ courseCode, classId, term })));
});

// --- Playwright Polling Worker ---
// in server.js

async function pollCourses() {
  if (activeWatches.length === 0) return;
  if (!fs.existsSync('auth.json')) {
    console.error('❌ No auth.json found! Run "node login.js" first.');
    return;
  }

  console.log(`\n🔍 Polling ${activeWatches.length} tracked target(s) on myUNSW...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: 'auth.json' });
  const page = await context.newPage();

  try {
    // 1. Open courses page
    await page.goto('https://my.unsw.edu.au/active/studentClassEnrol/courses.xml', { waitUntil: 'domcontentloaded' });

    // 2. CHECK IF SESSION EXPIRED / REDIRECTED TO SSO
    if (page.url().includes('login.microsoftonline.com') || page.url().includes('login.')) {
      console.error('🚨 [AUTH EXPIRED] Your session in auth.json has expired!');
      console.error('👉 Please open a terminal and run: node login.js');
      return;
    }

    // Quick verification that the course enrolment title is visible (timeout 8s instead of 30s)
    try {
      await page.waitForSelector('h3.un-page-title:has-text("Course Enrolment")', { timeout: 8000 });
    } catch {
      console.error('🚨 [AUTH ERROR] Could not reach Course Enrolment page. Run: node login.js');
      return;
    }

    // 3. Group targets by course and term
    const uniqueCourses = [...new Set(activeWatches.map(w => ({ course: w.courseCode, term: w.term })))];

    for (const item of uniqueCourses) {
      const { course, term } = item;

      // Ensure we are on the main courses page
      if (!page.url().endsWith('courses.xml')) {
        await page.goto('https://my.unsw.edu.au/active/studentClassEnrol/courses.xml');
      }

      // Switch to the requested Term tab (e.g. "Term 3 2026")
      const termTabButton = page.locator(`ul.nav-tabs a:has-text("${term}")`).first();
      if (await termTabButton.count() > 0) {
        await termTabButton.click();
        await page.waitForTimeout(500); // brief pause for tab fade animation
      }

      const activeTab = page.locator('div.tab-pane.show.active');

      // Check if course is already in the list
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

      // 4. Parse the Class Sections Table
      const rows = page.locator('section.un-page-section table.table tbody tr');
      const count = await rows.count();

      for (let i = 0; i < count; i++) {
        const cells = rows.nth(i).locator('td');
        if ((await cells.count()) < 11) continue;

        const classNbr = (await cells.nth(0).innerText()).trim();
        const component = (await cells.nth(2).innerText()).trim();
        const capacityText = (await cells.nth(9).innerText()).trim(); // "227 / 260"
        const [enrolled, max] = capacityText.split('/').map(n => parseInt(n.trim(), 10));

        // Check if there is an open spot
        if (enrolled < max) {
          console.log(`🎉 SPOT OPEN: ${course} Class #${classNbr} [${component}] (${enrolled}/${max})`);

          // Find users subscribed to this class or "ALL"
          const matchingSubs = activeWatches.filter(
            w => w.courseCode === course && (w.classId === 'ALL' || w.classId === classNbr)
          );

          for (const sub of matchingSubs) {
            const payload = JSON.stringify({
              title: `Spot Available in ${course}!`,
              body: `Class #${classNbr} [${component}] has open spots (${enrolled}/${max}). Click to enrol!`,
              url: 'https://my.unsw.edu.au'
            });

            webpush.sendNotification(sub.subscription, payload)
            .then(response => {
                console.log(`✅ Push successfully delivered to push server! Status: ${response.statusCode}`);
            })
            .catch(err => {
                console.error(`❌ WebPush Error (${err.statusCode}):`, err.body || err.message);
                if (err.statusCode === 410 || err.statusCode === 404) {
                activeWatches = activeWatches.filter(w => w !== sub);
                }
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Scraper error:', error.message);
  } finally {
    await browser.close();
  }
}

// Start polling every 2 minutes
setInterval(pollCourses, 120000);

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 PWA Server running at http://localhost:${PORT}`));