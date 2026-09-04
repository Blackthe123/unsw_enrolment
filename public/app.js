const GRAPHQL_URL = 'https://graphql.devsoc.app/v1/graphql';

const termSelect = document.getElementById('termSelect');
const courseInput = document.getElementById('courseInput');
const courseList = document.getElementById('courseList');
const classSelect = document.getElementById('classSelect');
const trackBtn = document.getElementById('trackBtn');
const statusMsg = document.getElementById('statusMsg');
const activeWatchesList = document.getElementById('activeWatches');
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

    courseList.innerHTML = '';
    courses.forEach(c => {
      const code = c.course_code.toUpperCase();
      validCourseCodes.add(code);

      const opt = document.createElement('option');
      opt.value = code;
      courseList.appendChild(opt);
    });
    console.log(`✅ Cached ${validCourseCodes.size} valid course codes.`);
  } catch (err) {
    console.error('Failed to load courses from DevSoc:', err);
  }
}

// 2. Fetch specific classes with Times/Days/Locations
async function loadClassesForCourse(courseCode, term) {
  courseCode = courseCode.trim().toUpperCase();

  // Validate course code exists
  if (validCourseCodes.size > 0 && !validCourseCodes.has(courseCode)) {
    courseValidationMsg.textContent = '❌ Course code not found in UNSW catalog.';
    courseValidationMsg.style.color = '#ef4444';
    classSelect.innerHTML = '<option value="">Invalid course code</option>';
    classSelect.disabled = true;
    return;
  } else {
    courseValidationMsg.textContent = '✅ Valid UNSW Course';
    courseValidationMsg.style.color = '#10b981';
  }

  classSelect.innerHTML = '<option value="">⏳ Loading class times...</option>';
  classSelect.disabled = true;

  const query = `
    query GetClasses($coursePattern: String!, $term: String!) {
      classes(where: { term: { _eq: $term }, course_id: { _ilike: $coursePattern } }) {
        class_id
        times {
          day
          time
          location
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
          coursePattern: `%${courseCode}%`,
          term: term
        }
      })
    });

    const { data } = await res.json();
    const classes = data?.classes || [];

    classSelect.innerHTML = '<option value="ALL" data-label="All Classes">🌟 Track ALL Classes in this Course</option>';

    if (classes.length > 0) {
      classes.forEach(c => {
        const classNbr = c.class_id.split('-').pop();
        let label = `Class #${classNbr}`;

        if (c.times && c.times.length > 0) {
          const t = c.times[0];
          const dayTime = t.day && t.time ? `[${t.day} ${t.time}]` : '';
          const location = t.location ? `📍 ${t.location}` : '';
          label = `Class #${classNbr} ${dayTime} ${location}`.trim();
        } else {
          label = `Class #${classNbr} (Online / TBA)`;
        }

        const opt = document.createElement('option');
        opt.value = classNbr;
        opt.dataset.label = label;
        opt.textContent = label;
        classSelect.appendChild(opt);
      });
      classSelect.disabled = false;
    } else {
      classSelect.innerHTML = '<option value="ALL" data-label="All Classes">Track All Classes (No individual sections)</option>';
      classSelect.disabled = false;
    }
  } catch (err) {
    console.error(err);
    classSelect.innerHTML = '<option value="ALL" data-label="All Classes">Track All Classes</option>';
    classSelect.disabled = false;
  }
}

courseInput.addEventListener('input', (e) => {
  if (e.target.value.length === 8) {
    loadClassesForCourse(e.target.value, termSelect.value);
  }
});

termSelect.addEventListener('change', () => {
  if (courseInput.value.length === 8) {
    loadClassesForCourse(courseInput.value, termSelect.value);
  }
});

// 3. Track Button Click
trackBtn.addEventListener('click', async () => {
  const courseCode = courseInput.value.trim().toUpperCase();
  const classId = classSelect.value || 'ALL';
  const selectedOpt = classSelect.options[classSelect.selectedIndex];
  const classLabel = selectedOpt ? selectedOpt.dataset.label || selectedOpt.textContent : 'All Classes';
  const term = termSelect.value;

  // Validation
  if (!courseCode || (validCourseCodes.size > 0 && !validCourseCodes.has(courseCode))) {
    alert('Please enter a valid 8-character UNSW course code (e.g. COMP1511).');
    return;
  }

  statusMsg.textContent = 'Requesting push permission...';

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const perm = await Notification.requestPermission();
    
    if (perm !== 'granted') {
      statusMsg.textContent = '❌ Push permission denied in browser settings.';
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
      statusMsg.textContent = data.message || `✅ Tracking ${courseCode}!`;
      loadMyWatches();
    }
  } catch (err) {
    statusMsg.textContent = `Error: ${err.message}`;
  }
});

// 4. Load Active Watches with Clean Sub-Class Display
async function loadMyWatches() {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;

  const sub = await reg.pushManager.getSubscription();
  if (!sub) {
    activeWatchesList.innerHTML = '<li class="muted-text">No active watches on this browser.</li>';
    return;
  }

  currentSubscription = sub;

  const res = await fetch('/api/my-watches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint })
  });

  const data = await res.json();
  
  if (!data || data.length === 0) {
    activeWatchesList.innerHTML = '<li class="muted-text">No active watches.</li>';
    return;
  }

  activeWatchesList.innerHTML = data.map(w => {
    let capacityBadge = `<span class="capacity-pill syncing">⏳ Syncing with myUNSW...</span>`;
    
    if (w.enrolled !== null && w.capacity !== null) {
      const isOpen = w.enrolled < w.capacity;
      const badgeClass = isOpen ? 'open' : 'full';
      capacityBadge = `<span class="capacity-pill ${badgeClass}">${w.enrolled} / ${w.capacity} (${isOpen ? 'Open' : 'Full'})</span>`;
    }

    // Format display label cleanly whether single class or "ALL"
    let displayTitle = `<b>${w.course_code}</b>`;
    let displayDetail = w.class_label;

    if (w.watched_class_id === 'ALL' && w.actual_class_id) {
      displayDetail = `Class #${w.actual_class_id} [${w.component || 'Section'}]`;
    }

    return `
      <li>
        <div class="watch-info">
          <div class="watch-header">
            ${displayTitle}
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

// Initial setup
loadCourseCodes();
loadMyWatches();