const GRAPHQL_URL = 'https://graphql.devsoc.app/v1/graphql';
const PUBLIC_VAPID_KEY = 'BE4-5123OzzVZGnXY_ZuR4PtD6uQ8NEcY44QsWo0uw0snnqCD02RcSavnK5gQmwHByIfXoLYl39FebAVB6IvcNA';

const termSelect = document.getElementById('termSelect');
const courseInput = document.getElementById('courseInput');
const courseList = document.getElementById('courseList');
const classSelect = document.getElementById('classSelect');
const trackBtn = document.getElementById('trackBtn');
const statusMsg = document.getElementById('statusMsg');

// 1. Fetch all course codes on load for Autocomplete
async function loadCourseCodes() {
  const query = `query { courses { course_code } }`;
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const data = await res.json();
  
  courseList.innerHTML = '';
  data.data.courses.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.course_code;
    courseList.appendChild(opt);
  });
}

// 2. Fetch specific classes when course & term are chosen
async function loadClassesForCourse(courseCode, term) {
  classSelect.innerHTML = '<option value="">⏳ Loading class times...</option>';
  classSelect.disabled = true;

  const query = `
    query GetClasses($coursePattern: String!, $term: String!) {
      classes(where: { term: { _eq: $term }, course_id: { _ilike: $coursePattern } }) {
        class_id
        course_id
        times {
          day
          time
          location
          instructor
        }
      }
    }
  `;

  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: {
          coursePattern: `%${courseCode.trim().toUpperCase()}%`,
          term: term
        }
      })
    });

    const { data } = await res.json();
    const classes = data?.classes || [];

    // Reset dropdown
    classSelect.innerHTML = '<option value="ALL">🌟 Track ALL Classes in this Course</option>';

    if (classes.length > 0) {
      classes.forEach(c => {
        // 1. Extract the actual 4-digit class number from the end of class_id
        // e.g. "GEOS1111-Undergraduate-2026-T3-6161" -> "6161"
        const classNbr = c.class_id.split('-').pop();

        // 2. Build a rich description (Day, Time, Instructor, Location)
        let label = `Class #${classNbr}`;

        if (c.times && c.times.length > 0) {
          const t = c.times[0]; // Primary time slot
          const dayTime = t.day && t.time ? `[${t.day} ${t.time}]` : '';
          const location = t.location ? `📍 ${t.location}` : '';
          const instructor = t.instructor ? `👤 ${t.instructor}` : '';

          label = `Class #${classNbr} ${dayTime} ${location} ${instructor}`.trim();
        } else {
          label = `Class #${classNbr} (Online / Flexible / TBA)`;
        }

        const opt = document.createElement('option');
        opt.value = classNbr; // Send just "6161" to backend for Playwright matching
        opt.textContent = label;
        classSelect.appendChild(opt);
      });

      classSelect.disabled = false;
    } else {
      classSelect.innerHTML = '<option value="ALL">No specific times found (Track All)</option>';
      classSelect.disabled = false;
    }
  } catch (err) {
    console.error('Error fetching classes:', err);
    classSelect.innerHTML = '<option value="ALL">Track All Classes (Error loading times)</option>';
    classSelect.disabled = false;
  }
}

courseInput.addEventListener('change', (e) => {
  if (e.target.value.length >= 8) {
    loadClassesForCourse(e.target.value, termSelect.value);
  }
});
termSelect.addEventListener('change', () => {
  if (courseInput.value.length >= 8) {
    loadClassesForCourse(courseInput.value, termSelect.value);
  }
});

// 3. Register Service Worker & Subscribe to Web Push
trackBtn.addEventListener('click', async () => {
  const courseCode = courseInput.value.trim().toUpperCase();
  const classId = classSelect.value;
  const term = termSelect.value;

  if (!courseCode) return alert('Please enter a course code.');

  statusMsg.textContent = 'Requesting push permission...';

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const perm = await Notification.requestPermission();
    
    if (perm !== 'granted') {
      statusMsg.textContent = '❌ Push notification permission denied.';
      return;
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: PUBLIC_VAPID_KEY
    });

    // Send tracking target to Backend Server
    const res = await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseCode, classId, term, subscription: sub })
    });

    if (res.ok) {
      statusMsg.textContent = `✅ Tracking ${courseCode} (${classId})! You will get a push alert when a spot opens.`;
      loadActiveWatches();
    }
  } catch (err) {
    statusMsg.textContent = `Error: ${err.message}`;
  }
});

async function loadActiveWatches() {
  const res = await fetch('/api/watches');
  const data = await res.json();
  const list = document.getElementById('activeWatches');
  list.innerHTML = data.map(w => `<li><span>${w.courseCode} (${w.classId})</span> <b>${w.term}</b></li>`).join('');
}

// Initial calls
loadCourseCodes();
loadActiveWatches();