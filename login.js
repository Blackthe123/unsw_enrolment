import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Navigating to myUNSW... Complete login and 2FA in the browser window.');
  await page.goto('https://my.unsw.edu.au/active/studentClassEnrol/courses.xml');

  // Wait until you are fully logged in and reach the Course Enrolment page
  await page.waitForSelector('h3.un-page-title:has-text("Course Enrolment")', { timeout: 120000 });

  // Save session cookies to file
  await context.storageState({ path: 'auth.json' });
  console.log('Session saved to auth.json! You can now run monitor.js');

  await browser.close();
})();