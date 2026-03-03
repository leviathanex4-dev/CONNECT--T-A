//====== GLOBAL VARIABLES ======
let role = "", currentUser = "", currentUserId = "", currentUserData = null;
let loginAttempts = 0;
const MAX_LOGIN_ATTEMPTS = 5;
let lockoutTimer = null;
let sessionTimer = null;
let sessionWarningTimer = null;
const SESSION_TIMEOUT = 30 * 60 * 1000;
const WARNING_BEFORE = 60 * 1000;
let db, auth, storage;
let unsubscribers = [];
let html5QrCodeScanner = null;
let firebaseReady = false;

// HARDCODED ADMIN CREDENTIALS
const HARDCODED_ADMIN = {
  username: "admin",
  password: "admin",
  name: "System Administrator",
  email: "admin@dshs.edu",
  role: "admin"
};

// Weekly Schedule Configuration
const WEEKLY_SCHEDULE = {
  periods: [
    { name: "1st Period", time: "7:45-8:45" },
    { name: "2nd Period", time: "8:45-9:45" },
    { name: "Recess", time: "9:45-10:00", type: "break" },
    { name: "3rd Period", time: "10:00-11:00" },
    { name: "4th Period", time: "11:00-12:00" },
    { name: "Lunch", time: "12:00-1:00", type: "break" },
    { name: "5th Period", time: "1:00-2:00" },
    { name: "6th Period", time: "2:00-3:00" },
    { name: "7th Period", time: "3:00-4:00" }
  ],
  days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
};

//====== INITIALIZATION ======
document.addEventListener('DOMContentLoaded', async function() {
  console.log('DOM Content Loaded - script.js active');
  
  // Set initial network status
  updateNetworkStatus();
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);

  // Polling for Firebase readiness
  let attempts = 0;
  const maxAttempts = 50; // 5 seconds total
  while(!window.firebaseFns && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 100));
    attempts++;
  }
  
  if(!window.firebaseFns) {
    console.error('Firebase CORE functions failed to load');
    const statusEl = document.getElementById('loadingStatus');
    if (statusEl) statusEl.textContent = 'Connection Error. Please refresh.';
    return;
  }
  
  // Initialize local Firebase handles
  db = window.firebaseDB;
  auth = window.firebaseAuth;
  storage = window.firebaseStorage;
  firebaseReady = true;
  
  const statusEl = document.getElementById('loadingStatus');
  if (statusEl) statusEl.textContent = 'Checking session...';
  
  // Set up auth state listener
  window.firebaseFns.onAuthStateChanged(auth, async (user) => {
    console.log('Auth state changed:', user ? user.email : 'Logged out');
    try {
      if(user) {
        currentUserId = user.uid;
        await loadUserData(user.uid);
      } else {
        document.getElementById('login').style.display = 'flex';
        document.getElementById('dashboard').style.display = 'none';
        role = ""; currentUser = ""; currentUserId = ""; currentUserData = null;
        hideLoadingOverlay();
      }
    } catch(error) {
      console.error('Auth handler error:', error);
      hideLoadingOverlay();
    }
  });
  
  setupPWA();
  
  // Safety timeout for loading screen
  setTimeout(() => {
    hideLoadingOverlay();
  }, 10000);
});

function updateNetworkStatus() {
  const indicator = document.getElementById('offlineIndicator');
  if (indicator) {
    indicator.style.display = navigator.onLine ? 'none' : 'block';
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
    setTimeout(() => {
      overlay.style.display = 'none';
    }, 500);
  }
}

//====== FIREBASE DATA FUNCTIONS ======
async function loadUserData(uid) {
  try {
    const userDocRef = window.firebaseFns.doc(db, 'users', uid);
    const userDoc = await window.firebaseFns.getDoc(userDocRef);
    
    if(userDoc.exists()) {
      currentUserData = userDoc.data();
      role = currentUserData.role;
      currentUser = currentUserData.name || currentUserData.email;
    } else if (auth.currentUser && auth.currentUser.email === "admin@gmail.com") {
      console.log('Auto-initializing admin@gmail.com');
      currentUserData = {
        uid: uid,
        name: "System Administrator",
        email: "admin@gmail.com",
        role: "admin",
        approved: true,
        createdAt: window.firebaseFns.serverTimestamp()
      };
      await window.firebaseFns.setDoc(userDocRef, currentUserData);
      role = "admin";
      currentUser = "System Administrator";
    } else {
      console.warn('No Firestore document for UID:', uid);
      await logout();
      showError('User profile not found.');
      return;
    }

    document.getElementById('login').style.display = 'none';
    document.getElementById('signup').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    
    if(role === 'student' && currentUserData.approved && currentUserData.section) {
      await syncStudentWithTeacher();
    }
    
    loadDashboard();
    startSessionTimer();
    addNotification('Welcome back!', 'system');
    hideLoadingOverlay();
  } catch(error) {
    console.error('loadUserData error:', error);
    hideLoadingOverlay();
  }
}

async function syncStudentWithTeacher() {
  if (!currentUserData.section) return;
  try {
    const teachersQuery = window.firebaseFns.query(
      window.firebaseFns.collection(db, 'users'),
      window.firebaseFns.where('role', '==', 'teacher'),
      window.firebaseFns.where('sectionHandled', '==', currentUserData.section)
    );
    const teacherSnapshot = await window.firebaseFns.getDocs(teachersQuery);
    if(!teacherSnapshot.empty) {
      const teacher = teacherSnapshot.docs[0];
      const teacherData = teacher.data();
      await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'users', currentUserId), {
        teacherId: teacher.id, teacherName: teacherData.name, teacherEmail: teacherData.email
      }, { merge: true });
      
      const teacherStudentsRef = window.firebaseFns.doc(db, 'teacherStudents', teacher.id);
      const tsDoc = await window.firebaseFns.getDoc(teacherStudentsRef);
      let students = tsDoc.exists() ? tsDoc.data().students || [] : [];
      if(!students.find(s => s.id === currentUserId)) {
        students.push({ id: currentUserId, name: currentUserData.name, studentId: currentUserData.studentId, section: currentUserData.section, gradeLevel: currentUserData.gradeLevel });
        await window.firebaseFns.setDoc(teacherStudentsRef, { students }, { merge: true });
      }
    }
  } catch(e) { console.warn('Sync error:', e); }
}

async function getCollectionData(collectionName, constraints = []) {
  if (!db) return [];
  try {
    const q = window.firebaseFns.query(window.firebaseFns.collection(db, collectionName), ...constraints);
    const snapshot = await window.firebaseFns.getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch(e) { return []; }
}

async function setDocument(collectionName, docId, data) {
  if (!db) return false;
  try {
    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, collectionName, docId), { ...data, updatedAt: window.firebaseFns.serverTimestamp() }, { merge: true });
    return true;
  } catch(e) { 
    if (e.code !== 'permission-denied') console.error('Firestore Write Error:', e.message);
    return false; 
  }
}

async function addDocument(collectionName, data) {
  if (!db) return null;
  try {
    const docRef = await window.firebaseFns.addDoc(window.firebaseFns.collection(db, collectionName), { ...data, createdAt: window.firebaseFns.serverTimestamp() });
    return docRef.id;
  } catch(e) { return null; }
}

//====== AUTHENTICATION FUNCTIONS ======
async function login() {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  if(!email || !password) { showError("Enter credentials"); return; }
  
  if(email === HARDCODED_ADMIN.username && password === HARDCODED_ADMIN.password) {
    role = HARDCODED_ADMIN.role; currentUser = HARDCODED_ADMIN.name;
    currentUserId = "HARDCODED_ADMIN_" + Date.now();
    currentUserData = { name: HARDCODED_ADMIN.name, role: 'admin' };
    document.getElementById('login').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    loadDashboard(); return;
  }
  
  try {
    document.getElementById('loadingOverlay').style.display = 'flex';
    document.getElementById('loadingOverlay').classList.remove('hidden');
    await window.firebaseFns.signInWithEmailAndPassword(auth, email, password);
  } catch(error) {
    hideLoadingOverlay();
    showError("Login failed: " + error.message);
  }
}

async function logout() {
  unsubscribers.forEach(unsub => { try { unsub(); } catch(e) {} });
  unsubscribers = [];
  if (auth && auth.currentUser) {
    try { await window.firebaseFns.signOut(auth); } catch(e) {}
  }
  location.reload();
}

//====== TEACHER CREATION FIX ======
async function createTeacher() {
  const name = document.getElementById("newTeacherName").value.trim();
  const section = document.getElementById("newTeacherSection").value.trim();
  const email = document.getElementById("newTeacherEmail").value.trim();
  const password = document.getElementById("newTeacherPassword").value.trim();
  
  if(!name || !email || !password || !section) { alert("All fields required!"); return; }
  
  try {
    document.getElementById('loadingOverlay').style.display = 'flex';
    document.getElementById('loadingOverlay').classList.remove('hidden');
    
    // Create secondary app instance to avoid admin logout
    const secondaryApp = window.firebaseFns.initializeApp(window.firebaseApp.options, "SecondaryApp_" + Date.now());
    const secondaryAuth = window.firebaseFns.getAuth(secondaryApp);
    
    const userCredential = await window.firebaseFns.createUserWithEmailAndPassword(secondaryAuth, email, password);
    const teacherUid = userCredential.user.uid;
    
    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'users', teacherUid), {
      uid: teacherUid, name, sectionHandled: section, email, role: 'teacher', approved: true, createdAt: window.firebaseFns.serverTimestamp()
    });
    
    await window.firebaseFns.deleteApp(secondaryApp);
    hideLoadingOverlay();
    alert("✅ Teacher account created successfully!");
    loadSection("Manage Users");
  } catch(error) {
    hideLoadingOverlay();
    alert("❌ Error: " + error.message);
  }
}

//====== SIGNUP FIX ======
async function submitSignup() {
  const name = document.getElementById("signupName").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const pass = document.getElementById("signupPass").value;
  // ... other fields ...
  
  try {
    document.getElementById('loadingOverlay').style.display = 'flex';
    document.getElementById('loadingOverlay').classList.remove('hidden');
    
    const cred = await window.firebaseFns.createUserWithEmailAndPassword(auth, email, pass);
    const uid = cred.user.uid;
    
    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'users', uid), {
      uid, name, email, role: 'student', approved: false, 
      studentId: document.getElementById("signupID").value,
      section: document.getElementById("signupSection").value,
      track: document.getElementById("signupTrack").value,
      strand: document.getElementById("signupStrand").value,
      gradeLevel: document.getElementById("signupGradeLevel").value,
      createdAt: window.firebaseFns.serverTimestamp()
    });
    
    await window.firebaseFns.signOut(auth);
    hideLoadingOverlay();
    alert("✅ Signup successful! Wait for admin approval.");
    showLogin();
  } catch(e) { hideLoadingOverlay(); showError(e.message); }
}

//====== UTILITY & DASHBOARD ======
function loadDashboard() {
  const menu = document.getElementById("menu");
  menu.innerHTML = `<div class="menu-header"><h3>🎓 DSHS Menu</h3><p>${currentUser}</p></div>`;
  
  let items = [];
  if(role === 'admin') items = [{name: "Student Approval", icon: "✅"}, {name: "Create Teacher", icon: "👨‍🏫"}, {name: "Manage Users", icon: "⚙️"}];
  else if(role === 'teacher') items = [{name: "Attendance", icon: "📅"}, {name: "Grades", icon: "📊"}];
  else if(role === 'student') items = [{name: "Attendance", icon: "📅"}, {name: "QR Code", icon: "🔳"}];
  
  items.forEach(item => {
    const btn = document.createElement("button");
    btn.innerHTML = `<span>${item.icon}</span> ${item.name}`;
    btn.onclick = () => { toggleMenu(); loadSection(item.name); };
    menu.appendChild(btn);
  });
  
  const lo = document.createElement("button");
  lo.innerHTML = "🚪 Logout"; lo.className = "logout";
  lo.onclick = logout; menu.appendChild(lo);
}

async function loadSection(tab) {
  unsubscribers.forEach(un => { try{un();}catch(e){} }); unsubscribers = [];
  const content = document.getElementById("content");
  content.innerHTML = `<h3>${tab}</h3>`;
  const section = document.createElement("div"); section.className = "section";
  
  if (tab === "Student Approval") {
    const q = window.firebaseFns.query(window.firebaseFns.collection(db, 'users'), window.firebaseFns.where('role', '==', 'student'), window.firebaseFns.where('approved', '==', false));
    const unsub = window.firebaseFns.onSnapshot(q, (snap) => {
      section.innerHTML = "";
      snap.forEach(doc => {
        const d = doc.data();
        const div = document.createElement("div");
        div.innerHTML = `<p>${d.name} (${d.section})</p><button onclick="approveStudent('${doc.id}')">Approve</button>`;
        section.appendChild(div);
      });
    });
    unsubscribers.push(unsub);
  } else if (tab === "Create Teacher") {
    section.innerHTML = `<input type="text" id="newTeacherName" placeholder="Full Name"><input type="text" id="newTeacherSection" placeholder="Section"><input type="email" id="newTeacherEmail" placeholder="Email"><input type="password" id="newTeacherPassword" placeholder="Password"><button onclick="createTeacher()">Create</button>`;
  }
  content.appendChild(section);
}

async function approveStudent(id) {
  try {
    await window.firebaseFns.updateDoc(window.firebaseFns.doc(db, 'users', id), { approved: true });
    alert("Approved!");
  } catch(e) { alert("Error: " + e.message); }
}

function toggleMenu() { document.getElementById("menu").classList.toggle("show"); document.getElementById("menuOverlay").classList.toggle("show"); }
function togglePassword() { const p = document.getElementById("loginPassword"); p.type = p.type === "password" ? "text" : "password"; }
function showSignup() { document.getElementById("login").style.display="none"; document.getElementById("signup").style.display="flex"; }
function showLogin() { document.getElementById("signup").style.display="none"; document.getElementById("forgotPassword").style.display="none"; document.getElementById("login").style.display="flex"; }
function showError(m) { const e = document.getElementById("msg"); if(e) { e.textContent = "❌ " + m; setTimeout(()=>e.textContent="", 5000); } }
async function updateAnalytics() {} // Simplified for now
function addNotification(m, t) { console.log("Notif:", m); }
function checkPasswordStrength() {}
function setupPWA() {}
function installPWA() {}

// Export
window.login = login; window.logout = logout; window.submitSignup = submitSignup; window.createTeacher = createTeacher;
window.toggleMenu = toggleMenu; window.togglePassword = togglePassword; window.showSignup = showSignup; window.showLogin = showLogin;
window.approveStudent = approveStudent; window.loadSection = loadSection;
window.installPWA = installPWA;
