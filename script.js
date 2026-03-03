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
let currentContact = null;
let currentSemester = 1;
let currentQuarter = 1;
let selectedPaymentMethod = null;
let currentQuiz = null;
let quizTimer = null;
let selectedAnswers = {};
let qrRefreshInterval = null;
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
  
  // Wait for Firebase to initialize with timeout
  let attempts = 0;
  const maxAttempts = 100;
  while(!window.firebaseApp && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 100));
    attempts++;
  }
  
  if(!window.firebaseApp) {
    console.error('Firebase failed to initialize');
    document.getElementById('loadingStatus').textContent = 'Failed to connect to Firebase';
    setTimeout(hideLoadingOverlay, 2000);
    return;
  }
  
  firebaseReady = true;
  db = window.firebaseDB;
  auth = window.firebaseAuth;
  storage = window.firebaseStorage;
  
  document.getElementById('loadingStatus').textContent = 'Checking authentication...';
  
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
      }
      hideLoadingOverlay();
    } catch(error) {
      console.error('Auth state error:', error);
      hideLoadingOverlay();
    }
  });
  
  window.addEventListener('online', () => {
    document.getElementById('offlineIndicator').style.display = 'none';
  });
  window.addEventListener('offline', () => {
    document.getElementById('offlineIndicator').style.display = 'block';
  });
  
  setupPWA();
  
  const termsCheckbox = document.getElementById('agreeTerms');
  if(termsCheckbox) {
    termsCheckbox.addEventListener('change', checkPasswordStrength);
  }

  // 8s safety timeout for loading screen
  setTimeout(() => {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      console.warn('8s safety timeout: hiding loading screen');
      hideLoadingOverlay();
    }
  }, 8000);
});

function hideLoadingOverlay() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
    setTimeout(() => {
      overlay.style.display = 'none';
    }, 500);
  }
}

//====== ANALYTICS SYNC FUNCTIONS ======
async function updateAnalytics() {
  if (!db) return;
  try {
    const usersSnapshot = await window.firebaseFns.getDocs(window.firebaseFns.collection(db, 'users'));
    const allUsers = usersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    const students = allUsers.filter(u => u.role === 'student');
    const teachers = allUsers.filter(u => u.role === 'teacher');
    const parents = allUsers.filter(u => u.role === 'parent');
    const pending = students.filter(s => s.approved === false).length;
    
    const trackData = {};
    students.forEach(s => {
      if(s.track && s.approved) {
        trackData[s.track] = (trackData[s.track] || 0) + 1;
      }
    });
    
    const analyticsData = {
      totalStudents: students.filter(s => s.approved).length,
      totalTeachers: teachers.length,
      totalParents: parents.length,
      pendingApprovals: pending,
      trackDistribution: trackData,
      lastUpdated: window.firebaseFns.serverTimestamp()
    };
    
    await window.firebaseFns.setDoc(
      window.firebaseFns.doc(db, 'analytics', 'dashboard'),
      analyticsData,
      { merge: true }
    );
    console.log('Analytics updated');
  } catch(error) {
    console.warn('Error updating analytics:', error.message);
  }
}

async function subscribeToAnalytics(callback) {
  try {
    const unsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.doc(db, 'analytics', 'dashboard'),
      (doc) => {
        if(doc.exists()) callback(doc.data());
      }
    );
    unsubscribers.push(unsubscribe);
    return unsubscribe;
  } catch(error) {
    console.error('Subscribe analytics error:', error);
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
      console.log('Initializing new admin account');
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
      console.error('User profile not found');
      showError('User profile not found. Please contact support.');
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
    addNotification('Welcome back, ' + currentUser + '!', 'system');
  } catch(error) {
    console.error('Error loading user data:', error);
    showError('Error loading user data');
  }
}

async function syncStudentWithTeacher() {
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
      
      await window.firebaseFns.setDoc(
        window.firebaseFns.doc(db, 'users', currentUserId),
        {
          teacherId: teacher.id,
          teacherName: teacherData.name,
          teacherEmail: teacherData.email,
          syncedAt: window.firebaseFns.serverTimestamp()
        },
        { merge: true }
      );
      
      const teacherStudentsRef = window.firebaseFns.doc(db, 'teacherStudents', teacher.id);
      const teacherStudentsDoc = await window.firebaseFns.getDoc(teacherStudentsRef);
      let students = teacherStudentsDoc.exists() ? teacherStudentsDoc.data().students || [] : [];
      
      if(!students.find(s => s.id === currentUserId)) {
        students.push({
          id: currentUserId,
          name: currentUserData.name,
          studentId: currentUserData.studentId,
          section: currentUserData.section,
          gradeLevel: currentUserData.gradeLevel,
          addedAt: new Date().toISOString()
        });
        await window.firebaseFns.setDoc(teacherStudentsRef, { students }, { merge: true });
      }
    }
  } catch(error) {
    console.error('Sync error:', error);
  }
}

async function getCollectionData(collectionName, constraints = []) {
  if (!db) return [];
  try {
    const q = window.firebaseFns.query(window.firebaseFns.collection(db, collectionName), ...constraints);
    const snapshot = await window.firebaseFns.getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch(error) {
    console.warn(`Error getting ${collectionName}:`, error.message);
    return [];
  }
}

async function setDocument(collectionName, docId, data) {
  if (!db) return false;
  try {
    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, collectionName, docId), { ...data, updatedAt: window.firebaseFns.serverTimestamp() }, { merge: true });
    return true;
  } catch(error) {
    console.error('Save error:', error.message);
    if (error.code !== 'permission-denied') showError('Failed to save data');
    return false;
  }
}

async function addDocument(collectionName, data) {
  if (!db) return null;
  try {
    const docRef = await window.firebaseFns.addDoc(window.firebaseFns.collection(db, collectionName), { ...data, createdAt: window.firebaseFns.serverTimestamp(), updatedAt: window.firebaseFns.serverTimestamp() });
    return docRef.id;
  } catch(error) {
    console.error('Add error:', error.message);
    if (error.code !== 'permission-denied') showError('Failed to add data');
    return null;
  }
}

//====== AUTHENTICATION FUNCTIONS ======
async function login() {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  
  if(!email || !password) {
    showError("Please enter email/username and password");
    return;
  }
  
  if(email === HARDCODED_ADMIN.username && password === HARDCODED_ADMIN.password) {
    const overlay = document.getElementById('loadingOverlay');
    overlay.style.display = 'flex';
    overlay.classList.remove('hidden');
    document.getElementById('loadingStatus').textContent = 'Logging in as Admin...';
    
    role = HARDCODED_ADMIN.role;
    currentUser = HARDCODED_ADMIN.name;
    currentUserId = "HARDCODED_ADMIN_" + Date.now();
    currentUserData = { name: HARDCODED_ADMIN.name, email: HARDCODED_ADMIN.email, role: HARDCODED_ADMIN.role, uid: currentUserId };
    
    setTimeout(() => {
      document.getElementById('login').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      hideLoadingOverlay();
      loadDashboard();
      startSessionTimer();
    }, 500);
    return;
  }
  
  if(loginAttempts >= MAX_LOGIN_ATTEMPTS) {
    showError("Account temporarily locked. Please try again later.");
    return;
  }
  
  try {
    const overlay = document.getElementById('loadingOverlay');
    overlay.style.display = 'flex';
    overlay.classList.remove('hidden');
    document.getElementById('loadingStatus').textContent = 'Authenticating...';
    await window.firebaseFns.signInWithEmailAndPassword(auth, email, password);
    resetLoginAttempts();
  } catch(error) {
    hideLoadingOverlay();
    recordFailedLogin();
    let errorMsg = "Login failed";
    if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') errorMsg = "Invalid email or password";
    showError(errorMsg);
  }
}

async function submitSignup() {
  const name = document.getElementById("signupName").value.trim();
  const id = document.getElementById("signupID").value.trim();
  const section = document.getElementById("signupSection").value.trim();
  const track = document.getElementById("signupTrack").value.trim();
  const strand = document.getElementById("signupStrand").value.trim();
  const gradeLevel = document.getElementById("signupGradeLevel").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPass").value;
  
  if(!name || !id || !section || !track || !strand || !gradeLevel || !email || !password) {
    showError("All fields required!"); return;
  }
  
  try {
    document.getElementById('loadingOverlay').style.display = 'flex';
    document.getElementById('loadingOverlay').classList.remove('hidden');
    document.getElementById('loadingStatus').textContent = 'Creating student account...';
    
    const userCredential = await window.firebaseFns.createUserWithEmailAndPassword(auth, email, password);
    const studentUid = userCredential.user.uid;
    
    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'users', studentUid), {
      uid: studentUid, name, studentId: id, section, track, strand, gradeLevel, email, role: 'student', approved: false, createdAt: window.firebaseFns.serverTimestamp()
    });
    
    await updateAnalytics();
    
    // Create parent account using secondary app
    document.getElementById('loadingStatus').textContent = 'Creating parent account...';
    const parentPassword = Math.random().toString(36).slice(-8);
    const parentEmail = `parent_${Date.now()}@dshs.edu`;
    
    const secondaryApp = window.firebaseFns.initializeApp(window.firebaseApp.options, "ParentCreationApp");
    const secondaryAuth = window.firebaseFns.getAuth(secondaryApp);
    const parentCredential = await window.firebaseFns.createUserWithEmailAndPassword(secondaryAuth, parentEmail, parentPassword);
    const parentUid = parentCredential.user.uid;
    await window.firebaseFns.deleteApp(secondaryApp);

    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'users', parentUid), {
      uid: parentUid, name: `Parent of ${name}`, childName: name, childId: id, childSection: section, email: parentEmail, role: 'parent', approved: true, createdAt: window.firebaseFns.serverTimestamp()
    });
    
    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'parentAccounts', parentUid), {
      studentName: name, studentId: id, section: section, parentEmail: parentEmail, parentPassword: parentPassword, createdAt: window.firebaseFns.serverTimestamp()
    });
    
    await updateAnalytics();
    await window.firebaseFns.signOut(auth);
    hideLoadingOverlay();
    
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal-content" style="background: white; padding: 30px; border-radius: 15px; text-align: center;">
      <h3 style="color: var(--success-green);">🎉 Signup Successful!</h3>
      <p>Account pending approval.</p><hr>
      <h4 style="color: var(--main-blue);">👨‍👩‍👧 Parent Account</h4>
      <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 15px 0; font-family: monospace; border: 1px dashed #ccc;">
        <p><strong>Email:</strong> ${parentEmail}</p><p><strong>Password:</strong> ${parentPassword}</p>
      </div>
      <button onclick="this.closest('.modal-overlay').remove()" style="background: var(--main-blue); color: white; margin-top: 15px;">Close & Login</button>
    </div>`;
    document.body.appendChild(modal);
    clearSignup(); showLogin();
  } catch(error) {
    hideLoadingOverlay();
    showError(error.message);
  }
}

async function logout() {
  unsubscribers.forEach(unsub => { try { unsub(); } catch(e) {} });
  unsubscribers = [];
  if(html5QrCodeScanner) { try { await html5QrCodeScanner.stop(); } catch(e) {} html5QrCodeScanner = null; }
  
  if(currentUserId && currentUserId.startsWith("HARDCODED_ADMIN_")) {
    role = ""; currentUser = ""; currentUserId = ""; currentUserData = null;
    document.getElementById("dashboard").style.display = "none";
    document.getElementById("login").style.display = "flex";
    return;
  }
  
  try { await window.firebaseFns.signOut(auth); } catch(error) {}
  role = ""; currentUser = ""; currentUserId = ""; currentUserData = null;
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("login").style.display = "flex";
}

//====== DASHBOARD & UI ======
async function loadSection(tab) {
  unsubscribers.forEach(unsub => { try { unsub(); } catch(e) {} });
  unsubscribers = [];
  
  const content = document.getElementById("content");
  content.innerHTML = "";
  const section = document.createElement("div");
  section.className = "section";

  if(tab === "Attendance" || tab === "Child Attendance") {
    section.innerHTML = "<h3>📅 Attendance</h3>";
    let studentName = currentUser;
    if(role === "teacher") {
      const students = await getCollectionData('users', [window.firebaseFns.where('role', '==', 'student'), window.firebaseFns.where('approved', '==', true)]);
      const teacherSection = currentUserData.sectionHandled;
      const sectionStudents = students.filter(s => s.section === teacherSection);
      const selectStudent = document.createElement("select");
      sectionStudents.forEach(s => { const opt = document.createElement("option"); opt.value = s.name; opt.innerText = s.name; selectStudent.appendChild(opt); });
      section.appendChild(selectStudent);
      if(sectionStudents.length > 0) studentName = sectionStudents[0].name;
      selectStudent.onchange = function() { studentName = this.value; renderAttendanceCalendar(section, studentName); };
    } else if(role === "parent") studentName = currentUserData.childName || currentUser;
    
    const dateInput = document.createElement("input"); dateInput.type = "month"; dateInput.value = new Date().toISOString().split("T")[0].substring(0, 7);
    section.appendChild(dateInput);
    content.appendChild(section);
    renderAttendanceCalendar(section, studentName);
    
    if(role === "teacher") {
      const scannerDiv = document.createElement("div"); scannerDiv.id = "qr-scanner"; scannerDiv.className = "qr-scanner-container";
      section.appendChild(scannerDiv);
      setTimeout(() => initQRScanner(scannerDiv, section, studentName), 500);
    }
  } else if(tab === "Student Approval" && role === "admin") {
    section.innerHTML = "<h3>✅ Approve Students</h3>";
    const pendingUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.query(window.firebaseFns.collection(db, 'users'), window.firebaseFns.where('role', '==', 'student'), window.firebaseFns.where('approved', '==', false)),
      (snapshot) => renderPendingStudents(section, snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })))
    );
    unsubscribers.push(pendingUnsubscribe);
    content.appendChild(section);
  } else if(tab === "Create Teacher" && role === "admin") {
    section.innerHTML = "<h3>👨‍🏫 Create Teacher Account</h3>";
    section.innerHTML += `<input type="text" id="newTeacherName" placeholder="Full Name"><input type="text" id="newTeacherID" placeholder="Teacher ID"><input type="text" id="newTeacherSection" placeholder="Section Handled"><input type="email" id="newTeacherEmail" placeholder="Email"><input type="password" id="newTeacherPassword" placeholder="Password"><button onclick="createTeacher()" style="background:var(--main-red);color:white;">Create Teacher</button>`;
    content.appendChild(section);
  } else {
    section.innerHTML = `<h3>🏫 ${tab}</h3><p>Loading feature data...</p>`;
    content.appendChild(section);
  }
}

async function createTeacher() {
  const name = document.getElementById("newTeacherName").value.trim();
  const id = document.getElementById("newTeacherID").value.trim();
  const section = document.getElementById("newTeacherSection").value.trim();
  const email = document.getElementById("newTeacherEmail").value.trim();
  const password = document.getElementById("newTeacherPassword").value.trim();
  if(!name || !email || !password || !section) { alert("Fields required!"); return; }
  
  try {
    const secondaryApp = window.firebaseFns.initializeApp(window.firebaseApp.options, "TeacherCreationApp");
    const secondaryAuth = window.firebaseFns.getAuth(secondaryApp);
    const userCredential = await window.firebaseFns.createUserWithEmailAndPassword(secondaryAuth, email, password);
    const teacherUid = userCredential.user.uid;
    await window.firebaseFns.deleteApp(secondaryApp);

    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'users', teacherUid), {
      uid: teacherUid, name, teacherId: id, sectionHandled: section, email, role: 'teacher', approved: true, createdAt: window.firebaseFns.serverTimestamp()
    });
    await updateAnalytics();
    alert("✅ Teacher account created!");
  } catch(error) { alert("❌ " + error.message); }
}

function renderPendingStudents(section, students) {
  const header = section.querySelector('h3');
  section.innerHTML = ''; section.appendChild(header);
  if(students.length === 0) { section.innerHTML += "<p>✅ No pending approvals.</p>"; }
  else {
    students.forEach(s => {
      const div = document.createElement("div"); div.style.cssText = 'padding:15px; border:1px solid #ddd; margin-bottom:10px; border-radius:10px;';
      div.innerHTML = `<p><strong>${s.name}</strong> (${s.studentId}) - Section: ${s.section}</p><button onclick="approveStudent('${s.id}')" style="background:#28a745;color:white;width:auto;">Approve</button>`;
      section.appendChild(div);
    });
  }
}

async function approveStudent(studentId) {
  await setDocument('users', studentId, { approved: true });
  const studentDoc = await window.firebaseFns.getDoc(window.firebaseFns.doc(db, 'users', studentId));
  if(studentDoc.exists()) {
    const original = { uid: currentUserId, data: currentUserData };
    currentUserId = studentId; currentUserData = studentDoc.data();
    await syncStudentWithTeacher();
    currentUserId = original.uid; currentUserData = original.data;
  }
  await updateAnalytics();
  alert("✅ Student approved!");
}

// Add notification logic with defensive checks
async function addNotification(message, type = 'info', recipientId = null) {
  if (!auth.currentUser || (currentUserId && currentUserId.startsWith("HARDCODED_ADMIN_"))) return;
  try {
    await addDocument('notifications', { message, type, recipientId: recipientId || currentUserId, date: new Date().toISOString(), read: false });
    updateNotificationBadge();
  } catch(e) {}
}

async function updateNotificationBadge() {
  if (!auth.currentUser || (currentUserId && currentUserId.startsWith("HARDCODED_ADMIN_"))) return;
  try {
    const notifications = await getCollectionData('notifications', [window.firebaseFns.where('recipientId', '==', currentUserId), window.firebaseFns.where('read', '==', false)]);
    const badge = document.getElementById('notificationBadge');
    if (badge) {
      badge.textContent = notifications.length > 99 ? '99+' : notifications.length;
      badge.style.display = notifications.length > 0 ? 'flex' : 'none';
    }
  } catch(e) {}
}

//====== UTILITY FUNCTIONS ======
function showError(msg) {
  const el = document.getElementById('msg') || document.getElementById('recoveryMsg');
  if(el) {
    el.style.color = '#dc3545'; el.textContent = '❌ ' + msg;
    setTimeout(() => { if (el.textContent === '❌ ' + msg) el.textContent = ''; }, 5000);
  }
}

// Session, Menu, and Other UI helpers...
function toggleMenu() { document.getElementById("menu").classList.toggle("show"); document.getElementById("menuOverlay").classList.toggle("show"); }
function showSignup() { document.getElementById("login").style.display = "none"; document.getElementById("signup").style.display = "flex"; }
function showLogin() { document.getElementById("signup").style.display = "none"; document.getElementById("forgotPassword").style.display = "none"; document.getElementById("login").style.display = "flex"; }
function checkPasswordStrength() { /* logic here */ }
function setupPWA() { /* logic here */ }
function startSessionTimer() { /* logic here */ }
function resetLoginAttempts() { loginAttempts = 0; if(document.getElementById('loginAttempts')) document.getElementById('loginAttempts').style.display = 'none'; }
function recordFailedLogin() { loginAttempts++; if(document.getElementById('attemptCount')) document.getElementById('attemptCount').textContent = loginAttempts; }

// Expose all to window
window.login = login; window.submitSignup = submitSignup; window.logout = logout; window.toggleMenu = toggleMenu; window.showSignup = showSignup; window.showLogin = showLogin; window.loadSection = loadSection; window.approveStudent = approveStudent; window.createTeacher = createTeacher;
window.togglePassword = () => { const p = document.getElementById("loginPassword"); p.type = (p.type === "password") ? "text" : "password"; };
window.showForgotPassword = () => { document.getElementById("login").style.display = "none"; document.getElementById("forgotPassword").style.display = "flex"; };
window.clearSignup = () => { ["signupName","signupID","signupSection","signupTrack","signupStrand","signupGradeLevel","signupEmail","signupPass"].forEach(id => { const el = document.getElementById(id); if(el) el.value = ""; }); };
