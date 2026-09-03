import { chromium } from 'playwright';
import fs from 'node:fs';

const TARGET_COURSE = 'ECON1101';
const TARGET_CLASS_NBR = '4537'; // (Optional) specific class number, or null for all classes

async function checkCapacity() {
  if (!fs.existsSync('auth.json')) {
    console.error('auth.json not found! Run "node login.js" first.');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: 'auth.json' });
  const page = await context.newPage();

  try {
    // 1. Open Course Enrolment Page
    await page.goto('https://my.unsw.edu.au/active/studentClassEnrol/courses.xml');

    // 2. Select the active term tab container (e.g. Term 3)
    const activeTab = page.locator('div.tab-pane.show.active');

    // 3. Check if course is already in the list
    const courseRow = activeTab.locator(`table.table tbody tr:has-text("${TARGET_COURSE}")`).first();
    const isAlreadyInList = (await courseRow.count()) > 0;

    if (isAlreadyInList) {
      console.log(`Found ${TARGET_COURSE} in existing course list.`);
      // Click the blue info button inside that row
      const infoBtn = courseRow.locator('button[name="bsdsSubmit-course-info"], button[title*="Show course information"]');
      await infoBtn.click();
    } else {
      console.log(`${TARGET_COURSE} not in current list. Searching for course...`);
      
      // Fill the search input and click "Search"
      const searchInput = activeTab.locator('input[name="search"]');
      const searchBtn = activeTab.locator('button[name="bsdsSubmit-search-courses"]');
      
      await searchInput.fill(TARGET_COURSE);
      await searchBtn.click();

      // Wait for results and click the info icon for the searched course
      const searchResultRow = page.locator(`table.table tbody tr:has-text("${TARGET_COURSE}")`).first();
      await searchResultRow.waitFor({ timeout: 5000 });
      
      const infoBtn = searchResultRow.locator('button[name="bsdsSubmit-course-info"], button[title*="Show course information"]');
      await infoBtn.click();
    }

    // 4. Wait for the "Course Information" page to load
    await page.waitForSelector('h3.un-page-title:has-text("Course Information")');

    // 5. Parse the Classes Table
    const classRows = page.locator('section.un-page-section table.table tbody tr');
    const rowCount = await classRows.count();
    
    console.log(`\n--- Availability for ${TARGET_COURSE} ---`);

    for (let i = 0; i < rowCount; i++) {
      const row = classRows.nth(i);
      const cells = row.locator('td');
      
      // Skip continuation/detail sub-rows that don't have all columns
      if ((await cells.count()) < 11) continue;

      const classNbr = (await cells.nth(0).innerText()).trim();
      const component = (await cells.nth(2).innerText()).trim();
      const mode = (await cells.nth(4).innerText()).trim();
      const day = (await cells.nth(6).innerText()).trim();
      const time = (await cells.nth(7).innerText()).trim();
      const capacityText = (await cells.nth(9).innerText()).trim(); // "227 / 260"
      const status = (await cells.nth(10).innerText()).trim();      // "Open" or "Closed"

      const [enrolled, max] = capacityText.split('/').map(num => parseInt(num.trim(), 10));

      console.log(`Class #${classNbr} [${component}] (${day} ${time}) -> ${enrolled}/${max} (${status})`);

      // Check if there is an open spot
      if ((!TARGET_CLASS_NBR || classNbr === TARGET_CLASS_NBR) && enrolled < max) {
        console.log(`🚨 SPOT AVAILABLE in Class #${classNbr}! (${max - enrolled} spot(s) remaining)`);
      }
    }

  } catch (error) {
    console.error('Error checking course:', error.message);
  } finally {
    await browser.close();
  }
}

// Run check immediately, then poll every 2 minutes (120000 ms)
checkCapacity();
setInterval(checkCapacity, 120000);