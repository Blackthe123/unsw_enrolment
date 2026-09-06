const GRAPHQL_URL = 'https://graphql.devsoc.app/v1/graphql';

const termSelect = document.getElementById('termSelect');
const courseInput = document.getElementById('courseInput');
const courseList = document.getElementById('courseList');
const classSelect = document.getElementById('classSelect');
const trackBtn = document.getElementById('trackBtn');
const statusMsg = document.getElementById('statusMsg');
const activeWatchesList = document.getElementById('activeWatches');
const courseOverviewList = document.getElementById('courseOverviewList');
const courseValidationMsg = document.getElementById('courseValidationMsg');

let currentSubscription = null;
let validCourseCodes = new Set();

// 1. Fetch & Cache Valid Course Codes
async function loadCourseCodes() {
  const query = `query { courses { course_code } }`;
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const result = await res.json();
    const courses = result.data?.courses || [];

    if (courseList) {
      courseList.innerHTML = '';
      courses.forEach(c => {
        const code = c.course_code.toUpperCase();
        validCourseCodes.add(code);

        const opt = document.createElement('option');
        opt.value = code;
        courseList.appendChild(opt);
      });
    }
  } catch (err) {
    console.error('Failed to load courses from DevSoc:', err);
  }
}

// 2. Fetch specific classes with Times/Days/Locations
async function loadClassesForCourse(courseCode, term) {
  courseCode = courseCode.trim().toUpperCase();

  classSelect.innerHTML = '<option value="">⏳ Fetching classes from UNSW Timetable...</option>';
  classSelect.disabled = true;

  try {
    const res = await fetch(`/api/classes/${courseCode}/${term}`);
    const classes = await res.json();

    classSelect.innerHTML = '<option value="ALL" data-label="All Classes">🌟 Track ALL Classes in this Course</option>';

    if (classes && classes.length > 0) {
      classes.forEach(c => {
        // 1. Shorten Activity names
        const activity = (c.activity || 'Class')
          .replace('Tutorial-Laboratory', 'Tut-Lab')
          .replace('Tutorial', 'Tut')
          .replace('Lecture', 'Lec')
          .replace('Laboratory', 'Lab');

        // 2. Clean Location: Strip redundant grid codes like "(K-E8-G05)" and "(ONLINE)"
        let loc = (c.location || '')
          .replace(/\(K-[A-Z0-9-]+\)/gi, '') // Removes grid codes
          .replace(/\(ONLINE\)/gi, '')
          .replace(/Science & Engineering/gi, 'Sci & Eng')
          .replace(/\s+/g, ' ')
          .trim();

        // 3. Compact times format
        const times = c.times ? `[${c.times}]` : '';
        const locFormatted = loc ? `📍 ${loc}` : '';

        // Final clean, readable label that fits on screen
        const label = `Class #${c.classNbr} [${activity} - ${c.section || ''}] ${times} ${locFormatted}`.replace(/\s+/g, ' ').trim();

        const opt = document.createElement('option');
        opt.value = c.classNbr;
        opt.dataset.label = label;
        opt.textContent = label;
        classSelect.appendChild(opt);
      });
      classSelect.disabled = false;
    } else {
      classSelect.innerHTML = '<option value="ALL" data-label="All Classes">Track All Classes (No individual sections found)</option>';
      classSelect.disabled = false;
    }
  } catch (err) {
    console.error('Failed to load classes from Timetable:', err);
    classSelect.innerHTML = '<option value="ALL" data-label="All Classes">Track All Classes</option>';
    classSelect.disabled = false;
  }
}

if (courseInput) {
  courseInput.addEventListener('input', (e) => {
    if (e.target.value.length === 8) {
      loadClassesForCourse(e.target.value, termSelect.value);
    }
  });
}

if (termSelect) {
  termSelect.addEventListener('change', () => {
    if (courseInput && courseInput.value.length === 8) {
      loadClassesForCourse(courseInput.value, termSelect.value);
    }
  });
}

// 3. Track Button Click
if (trackBtn) {
  trackBtn.addEventListener('click', async () => {
    const courseCode = courseInput.value.trim().toUpperCase();
    const classId = classSelect.value || 'ALL';
    const selectedOpt = classSelect.options[classSelect.selectedIndex];
    const classLabel = selectedOpt ? selectedOpt.dataset.label || selectedOpt.textContent : 'All Classes';
    const term = termSelect.value;

    if (!courseCode || (validCourseCodes.size > 0 && !validCourseCodes.has(courseCode))) {
      alert('Please enter a valid 8-character UNSW course code (e.g. COMP1511).');
      return;
    }

    // --- 1. PURE FEATURE DETECTION ---
    const hasServiceWorker = 'serviceWorker' in navigator;
    const hasNotification = 'Notification' in window;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || Boolean(navigator.standalone);

    // Case A: Device/Browser has no Service Worker support at all
    if (!hasServiceWorker) {
      alert('❌ This browser does not support Web Push notifications.');
      return;
    }

    // Case B: Notification API is missing because it's running inside a browser tab that requires PWA installation (e.g. iOS Safari)
    if (!hasNotification) {
      if (!isStandalone) {
        alert(
          "📱 Installation Required:\n\n" +
          "Your browser requires this web app to be added to your Home Screen before notifications can be enabled:\n\n" +
          "1. Tap Share (⎋)\n" +
          "2. Tap 'Add to Home Screen'\n" +
          "3. Open the app from your Home Screen to enable alerts!"
        );
      } else {
        // Installed, but OS still lacks Notification API (e.g. iOS < 16.4)
        alert('❌ Notifications are not supported on your operating system version. Please update your device.');
      }
      return;
    }

    // --- 2. PROCEED WITH PERMISSION & REGISTRATION ---
    if (statusMsg) statusMsg.textContent = 'Requesting push permission...';

    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const perm = await Notification.requestPermission();
      
      if (perm !== 'granted') {
        if (statusMsg) statusMsg.textContent = '❌ Push permission denied in browser settings.';
        return;
      }

      const { publicKey } = await fetch('/api/vapid-public-key').then(r => r.json());

      currentSubscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey
      });

      const res = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseCode,
          classId,
          classLabel,
          term,
          subscription: currentSubscription
        })
      });

      const data = await res.json();
      if (data.success) {
        if (statusMsg) statusMsg.textContent = data.message || `✅ Tracking ${courseCode}!`;
        loadMyWatches();
      }
    } catch (err) {
      if (statusMsg) statusMsg.textContent = `Error: ${err.message}`;
    }
  });
}

// 4. Load Active Watches & Overall Course Capacities (With Null Guards)
async function loadMyWatches() {
  if (!navigator.serviceWorker) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;

  const sub = await reg.pushManager.getSubscription();
  if (!sub) {
    if (activeWatchesList) activeWatchesList.innerHTML = '<li class="muted-text">No active watches on this browser.</li>';
    if (courseOverviewList) courseOverviewList.innerHTML = '<li class="muted-text">Track a course to view overall capacity.</li>';
    return;
  }

  currentSubscription = sub;

  try {
    const res = await fetch('/api/my-watches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint })
    });

    const { watches = [], courseCapacities = [] } = await res.json();

    // A. Render Overall Course Capacities Card
    if (courseOverviewList) {
      if (courseCapacities.length === 0) {
        courseOverviewList.innerHTML = '<li class="muted-text">No courses tracked yet.</li>';
      } else {
        courseOverviewList.innerHTML = courseCapacities.map(c => {
          let badge = `<span class="capacity-pill syncing">⏳ Syncing...</span>`;
          if (c.enrolled !== null && c.capacity !== null) {
            const isOpen = c.enrolled < c.capacity;
            badge = `<span class="capacity-pill ${isOpen ? 'open' : 'full'}">${c.enrolled} / ${c.capacity} (${isOpen ? 'Open' : 'Full'})</span>`;
          }
          return `
            <li class="course-overview-item">
              <div><b>${c.course_code}</b> <span class="badge">${c.term}</span></div>
              <div>${badge}</div>
            </li>
          `;
        }).join('');
      }
    }

    // B. Render Individual Class Watch List
    if (activeWatchesList) {
      if (watches.length === 0) {
        activeWatchesList.innerHTML = '<li class="muted-text">No active watches.</li>';
        return;
      }

      activeWatchesList.innerHTML = watches.map(w => {
        let capacityBadge = `<span class="capacity-pill syncing">⏳ Syncing...</span>`;
        
        if (w.enrolled !== null && w.capacity !== null) {
          const isOpen = w.enrolled < w.capacity;
          const badgeClass = isOpen ? 'open' : 'full';
          capacityBadge = `<span class="capacity-pill ${badgeClass}">${w.enrolled} / ${w.capacity} (${isOpen ? 'Open' : 'Full'})</span>`;
        }

        let displayDetail = w.class_label;

        if (w.watched_class_id === 'ALL' && w.actual_class_id) {
          const timeSlot = w.day && w.time ? `[${w.day} ${w.time}]` : '';
          const loc = w.location ? `📍 ${w.location}` : '';
          displayDetail = `Class #${w.actual_class_id} [${w.component || 'Section'}] ${timeSlot} ${loc}`.trim();
        }

        return `
          <li>
            <div class="watch-info">
              <div class="watch-header">
                <b>${w.course_code}</b>
                <span class="badge">${w.term}</span>
              </div>
              <div class="watch-details">${displayDetail}</div>
              <div class="watch-capacity">${capacityBadge}</div>
            </div>
            <button class="delete-btn" onclick="removeWatch(${w.watch_id})">✕</button>
          </li>
        `;
      }).join('');
    }
  } catch (err) {
    console.error('Error refreshing watches:', err);
  }
}

// 5. Remove Watch
window.removeWatch = async function(id) {
  if (!currentSubscription) return;

  await fetch('/api/untrack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, endpoint: currentSubscription.endpoint })
  });

  loadMyWatches();
};

// Function to fetch and render live community stats
async function loadLiveStats() {
  const statsElem = document.getElementById('statsCounter');
  if (!statsElem) return;

  try {
    const res = await fetch('/api/stats');
    const { totalUsers, uniqueCourses } = await res.json();

    const courseWord = uniqueCourses === 1 ? 'course' : 'courses';
    const studentWord = totalUsers === 1 ? 'student' : 'students';

    statsElem.innerHTML = `⚡ Currently watching <b>${uniqueCourses} ${courseWord}</b> for <b>${totalUsers} ${studentWord}</b>`;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// Call on startup
loadLiveStats();

// Auto-refresh stats along with your regular UI refresh
setInterval(loadLiveStats, 30000);


// Automatic 15-second background UI refresh
setInterval(loadMyWatches, 15000);

loadCourseCodes();
loadMyWatches();