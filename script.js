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
let html5QrCodeScanner = null; // Track scanner instance

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
    // Force hide overlay after timeout
    setTimeout(hideLoadingOverlay, 2000);
    return;
  }
  
  db = window.firebaseDB;
  auth = window.firebaseAuth;
  storage = window.firebaseStorage;
  
  document.getElementById('loadingStatus').textContent = 'Checking authentication...';
  
  // Set up auth state listener
  window.firebaseFns.onAuthStateChanged(auth, async (user) => {
    try {
      if(user) {
        currentUserId = user.uid;
        await loadUserData(user.uid);
      } else {
        // Not logged in - show login screen
        document.getElementById('login').style.display = 'flex';
        document.getElementById('dashboard').style.display = 'none';
      }
      
      hideLoadingOverlay();
    } catch(error) {
      console.error('Auth state error:', error);
      hideLoadingOverlay();
    }
  });
  
  // Network status listeners
  window.addEventListener('online', () => {
    document.getElementById('offlineIndicator').style.display = 'none';
  });
  
  window.addEventListener('offline', () => {
    document.getElementById('offlineIndicator').style.display = 'block';
  });
  
  setupPWA();
  
  // Add event listener for terms checkbox
  const termsCheckbox = document.getElementById('agreeTerms');
  if(termsCheckbox) {
    termsCheckbox.addEventListener('change', checkPasswordStrength);
  }
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
  try {
    const allUsers = await getCollectionData('users');
    const students = allUsers.filter(u => u.role === 'student');
    const teachers = allUsers.filter(u => u.role === 'teacher');
    const parents = allUsers.filter(u => u.role === 'parent');
    const pending = students.filter(s => s.approved === false).length;
    
    const trackData = {};
    students.forEach(s => {
      if (s.track && s.approved) {
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
    
    console.log('Analytics updated successfully');
  } catch(error) {
    console.error('Error updating analytics:', error);
  }
}

async function subscribeToAnalytics(callback) {
  try {
    const unsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.doc(db, 'analytics', 'dashboard'),
      (doc) => {
        if(doc.exists()) {
          callback(doc.data());
        }
      },
      (error) => {
        console.error('Analytics subscription error:', error);
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
      // Auto-initialize the new admin account if Firestore doc is missing
      console.log('Initializing new admin account in Firestore');
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
      console.error('User document not found for UID:', uid);
      showError('User profile not found. Please contact support.');
      return;
    }

    document.getElementById('login').style.display = 'none';
    document.getElementById('signup').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    
    // Sync student with teacher if approved
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

// Sync student with teacher based on section
async function syncStudentWithTeacher() {
  try {
    // Find teacher who handles this student's section
    const teachersQuery = window.firebaseFns.query(
      window.firebaseFns.collection(db, 'users'),
      window.firebaseFns.where('role', '==', 'teacher'),
      window.firebaseFns.where('sectionHandled', '==', currentUserData.section)
    );
    
    const teacherSnapshot = await window.firebaseFns.getDocs(teachersQuery);
    
    if(!teacherSnapshot.empty) {
      const teacher = teacherSnapshot.docs[0];
      const teacherData = teacher.data();
      
      // Update student record with teacher info
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
      
      // Add student to teacher's student list
      const teacherStudentsRef = window.firebaseFns.doc(db, 'teacherStudents', teacher.id);
      const teacherStudentsDoc = await window.firebaseFns.getDoc(teacherStudentsRef);
      
      if(teacherStudentsDoc.exists()) {
        const data = teacherStudentsDoc.data();
        const students = data.students || [];
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
      } else {
        await window.firebaseFns.setDoc(teacherStudentsRef, {
          students: [{
            id: currentUserId,
            name: currentUserData.name,
            studentId: currentUserData.studentId,
            section: currentUserData.section,
            gradeLevel: currentUserData.gradeLevel,
            addedAt: new Date().toISOString()
          }]
        });
      }
      
      console.log('Student synced with teacher:', teacherData.name);
    }
  } catch(error) {
    console.error('Error syncing student with teacher:', error);
  }
}

async function getCollectionData(collectionName, constraints = []) {
  try {
    const q = window.firebaseFns.query(
      window.firebaseFns.collection(db, collectionName),
      ...constraints
    );
    const snapshot = await window.firebaseFns.getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch(error) {
    console.error('Error getting collection:', error);
    return [];
  }
}

async function setDocument(collectionName, docId, data) {
  try {
    await window.firebaseFns.setDoc(
      window.firebaseFns.doc(db, collectionName, docId),
      { ...data, updatedAt: window.firebaseFns.serverTimestamp() },
      { merge: true }
    );
    return true;
  } catch(error) {
    console.error('Error setting document:', error);
    showError('Failed to save data');
    return false;
  }
}

async function addDocument(collectionName, data) {
  try {
    const docRef = await window.firebaseFns.addDoc(
      window.firebaseFns.collection(db, collectionName),
      { ...data, createdAt: window.firebaseFns.serverTimestamp(), updatedAt: window.firebaseFns.serverTimestamp() }
    );
    return docRef.id;
  } catch(error) {
    console.error('Error adding document:', error);
    showError('Failed to add data');
    return null;
  }
}

function subscribeToCollection(collectionName, callback, constraints = []) {
  try {
    const q = window.firebaseFns.query(
      window.firebaseFns.collection(db, collectionName),
      ...constraints
    );
    const unsubscribe = window.firebaseFns.onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      callback(data);
    }, (error) => {
      console.error('Subscription error:', error);
    });
    unsubscribers.push(unsubscribe);
    return unsubscribe;
  } catch(error) {
    console.error('Subscribe collection error:', error);
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
  
  // CHECK HARDCODED ADMIN LOGIN
  if(email === HARDCODED_ADMIN.username && password === HARDCODED_ADMIN.password) {
    document.getElementById('loadingOverlay').style.display = 'flex';
    document.getElementById('loadingOverlay').classList.remove('hidden');
    document.getElementById('loadingStatus').textContent = 'Logging in as Admin...';
    
    role = HARDCODED_ADMIN.role;
    currentUser = HARDCODED_ADMIN.name;
    currentUserId = "HARDCODED_ADMIN_" + Date.now();
    currentUserData = {
      name: HARDCODED_ADMIN.name,
      email: HARDCODED_ADMIN.email,
      role: HARDCODED_ADMIN.role,
      uid: currentUserId
    };
    
    setTimeout(() => {
      document.getElementById('login').style.display = 'none';
      document.getElementById('signup').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      hideLoadingOverlay();
      
      loadDashboard();
      startSessionTimer();
      addNotification('Welcome back, Administrator!', 'system');
    }, 500);
    
    return;
  }
  
  if(loginAttempts >= MAX_LOGIN_ATTEMPTS) {
    showError("Account temporarily locked. Please try again later.");
    return;
  }
  
  try {
    document.getElementById('loadingOverlay').style.display = 'flex';
    document.getElementById('loadingOverlay').classList.remove('hidden');
    document.getElementById('loadingStatus').textContent = 'Authenticating...';
    
    const userCredential = await window.firebaseFns.signInWithEmailAndPassword(auth, email, password);
    resetLoginAttempts();
    
  } catch(error) {
    hideLoadingOverlay();
    console.error('Login error:', error);
    recordFailedLogin();
    
    let errorMsg = "Login failed";
    switch(error.code) {
      case 'auth/user-not-found':
        errorMsg = "User not found";
        break;
      case 'auth/wrong-password':
        errorMsg = "Invalid password";
        break;
      case 'auth/invalid-email':
        errorMsg = "Invalid email format";
        break;
      case 'auth/user-disabled':
        errorMsg = "Account disabled";
        break;
      case 'auth/invalid-credential':
        errorMsg = "Invalid email or password";
        break;
    }
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
    showError("All fields required!");
    return;
  }
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if(!emailRegex.test(email)) {
    showError("Please enter a valid email address");
    return;
  }
  
  try {
    document.getElementById('loadingOverlay').style.display = 'flex';
    document.getElementById('loadingOverlay').classList.remove('hidden');
    document.getElementById('loadingStatus').textContent = 'Creating student account...';
    
    // 1. Create student Auth account
    const userCredential = await window.firebaseFns.createUserWithEmailAndPassword(auth, email, password);
    const studentUid = userCredential.user.uid;
    
    // 2. Save student Firestore data
    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'users', studentUid), {
      uid: studentUid,
      name,
      studentId: id,
      section,
      track,
      strand,
      gradeLevel,
      email,
      role: 'student',
      approved: false,
      createdAt: window.firebaseFns.serverTimestamp()
    });
    
    // Update analytics
    await updateAnalytics();
    
    document.getElementById('loadingStatus').textContent = 'Creating parent account...';
    
    // 3. Create parent account using SECONDARY APP to avoid session logout
    const parentPassword = Math.random().toString(36).slice(-8);
    const parentEmail = `parent_${Date.now()}@dshs.edu`; // Unique internal email
    
    const secondaryApp = window.firebaseFns.initializeApp(window.firebaseApp.options, "ParentCreationApp");
    const secondaryAuth = window.firebaseFns.getAuth(secondaryApp);
    
    const parentCredential = await window.firebaseFns.createUserWithEmailAndPassword(secondaryAuth, parentEmail, parentPassword);
    const parentUid = parentCredential.user.uid;
    
    // Clean up secondary app
    await window.firebaseFns.deleteApp(secondaryApp);

    // 4. Save parent Firestore data
    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'users', parentUid), {
      uid: parentUid,
      name: `Parent of ${name}`,
      childName: name,
      childId: id,
      childSection: section,
      email: parentEmail,
      role: 'parent',
      approved: true,
      createdAt: window.firebaseFns.serverTimestamp()
    });
    
    // 5. Store parent credentials for Admin (using current Auth session which is the Student)
    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'parentAccounts', parentUid), {
      studentName: name,
      studentId: id,
      section: section,
      parentEmail: parentEmail,
      parentPassword: parentPassword,
      createdAt: window.firebaseFns.serverTimestamp()
    });
    
    // Update analytics
    await updateAnalytics();
    
    // Sign out the current session (Student)
    await window.firebaseFns.signOut(auth);
    hideLoadingOverlay();
    
    // Show credentials in a way they can be copied
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content" style="background: white; padding: 30px; border-radius: 15px; max-width: 400px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.3);">
        <h3 style="color: var(--success-green);">🎉 Signup Successful!</h3>
        <p>Your account is pending approval.</p>
        <hr>
        <h4 style="color: var(--main-blue);">👨‍👩‍👧 Parent Account</h4>
        <p style="font-size: 13px; color: #666;">Provide these to your parent/guardian:</p>
        <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 15px 0; font-family: monospace; border: 1px dashed #ccc;">
          <p style="margin: 5px 0;"><strong>Email:</strong> ${parentEmail}</p>
          <p style="margin: 5px 0;"><strong>Password:</strong> ${parentPassword}</p>
        </div>
        <p style="font-size: 11px; color: #dc3545;">⚠️ Save these! They will not be shown again.</p>
        <button onclick="this.closest('.modal-overlay').remove()" style="background: var(--main-blue); color: white; margin-top: 15px;">Close & Login</button>
      </div>
    `;
    document.body.appendChild(modal);
    
    clearSignup();
    showLogin();
    
  } catch(error) {
    hideLoadingOverlay();
    console.error('Signup error:', error);
    
    let errorMsg = "Signup failed";
    if(error.code === 'auth/email-already-in-use') {
      errorMsg = "Email already registered";
    } else if(error.code === 'auth/weak-password') {
      errorMsg = "Password is too weak";
    } else if(error.message) {
      errorMsg = error.message;
    }
    showError(errorMsg);
  }
}

async function sendRecoveryEmail() {
  const email = document.getElementById("recoveryEmail").value.trim();
  if(!email) {
    showError("Please enter your email");
    return;
  }
  
  try {
    await window.firebaseFns.sendPasswordResetEmail(auth, email);
    document.getElementById("recoveryMsg").style.color = "green";
    document.getElementById("recoveryMsg").textContent = "✅ Password reset email sent! Check your inbox.";
  } catch(error) {
    document.getElementById("recoveryMsg").style.color = "red";
    document.getElementById("recoveryMsg").textContent = "❌ " + error.message;
  }
}

async function logout() {
  // Clean up all subscriptions
  unsubscribers.forEach(unsub => {
    try {
      unsub();
    } catch(e) {
      console.error('Error unsubscribing:', e);
    }
  });
  unsubscribers = [];
  
  // Stop QR scanner if running
  if(html5QrCodeScanner) {
    try {
      await html5QrCodeScanner.stop();
      html5QrCodeScanner = null;
    } catch(e) {
      console.error('Error stopping scanner:', e);
    }
  }
  
  // Handle hardcoded admin logout
  if(currentUserId && currentUserId.startsWith("HARDCODED_ADMIN_")) {
    role = "";
    currentUser = "";
    currentUserId = "";
    currentUserData = null;
    
    document.getElementById("dashboard").style.display = "none";
    document.getElementById("login").style.display = "flex";
    document.getElementById("menu").classList.remove("show");
    document.getElementById("menuOverlay").classList.remove("show");
    
    if(sessionTimer) clearTimeout(sessionTimer);
    if(sessionWarningTimer) clearTimeout(sessionWarningTimer);
    document.getElementById('sessionWarning').style.display = 'none';
    return;
  }
  
  // Firebase logout
  try {
    await window.firebaseFns.signOut(auth);
  } catch(error) {
    console.error('Logout error:', error);
  }
  
  role = "";
  currentUser = "";
  currentUserId = "";
  currentUserData = null;
  
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("login").style.display = "flex";
  document.getElementById("menu").classList.remove("show");
  document.getElementById("menuOverlay").classList.remove("show");
  
  if(sessionTimer) clearTimeout(sessionTimer);
  if(sessionWarningTimer) clearTimeout(sessionWarningTimer);
  document.getElementById('sessionWarning').style.display = 'none';
}

//====== UI FUNCTIONS ======
function toggleMenu() {
  const menu = document.getElementById("menu");
  const overlay = document.getElementById("menuOverlay");
  const toggleBtn = document.getElementById("toggleBtn");
  
  menu.classList.toggle("show");
  overlay.classList.toggle("show");
  toggleBtn.classList.toggle("small", menu.classList.contains("show"));
}

function togglePassword() {
  const p = document.getElementById("loginPassword");
  if (p) p.type = (p.type === "password") ? "text" : "password";
}

function showSignup() {
  document.getElementById("login").style.display = "none";
  document.getElementById("signup").style.display = "flex";
}

function showLogin() {
  document.getElementById("signup").style.display = "none";
  document.getElementById("forgotPassword").style.display = "none";
  document.getElementById("login").style.display = "flex";
}

function showForgotPassword() {
  document.getElementById("login").style.display = "none";
  document.getElementById("forgotPassword").style.display = "flex";
}

function clearSignup() {
  ["signupName","signupID","signupSection","signupTrack","signupStrand","signupGradeLevel","signupEmail","signupPass"].forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const strengthBar = document.getElementById('signupPasswordStrength');
  if (strengthBar) strengthBar.className = 'password-strength';
  const strengthText = document.getElementById('signupStrengthText');
  if (strengthText) strengthText.textContent = '';
  const terms = document.getElementById('agreeTerms');
  if (terms) terms.checked = false;
  const btn = document.getElementById('signupBtn');
  if (btn) btn.disabled = true;
}

function checkPasswordStrength() {
  const password = document.getElementById('signupPass').value;
  const strengthBar = document.getElementById('signupPasswordStrength');
  const strengthText = document.getElementById('signupStrengthText');
  const signupBtn = document.getElementById('signupBtn');
  
  let strength = 0;
  if(password.length >= 8) strength++;
  if(password.match(/[a-z]+/)) strength++;
  if(password.match(/[A-Z]+/)) strength++;
  if(password.match(/[0-9]+/)) strength++;
  if(password.match(/[$@#&!]+/)) strength++;
  
  strengthBar.className = 'password-strength';
  
  if(strength <= 2) {
    strengthBar.classList.add('weak');
    strengthText.textContent = 'Weak - Add more character types';
    strengthText.style.color = '#dc3545';
  } else if(strength === 3 || strength === 4) {
    strengthBar.classList.add('medium');
    strengthText.textContent = 'Medium - Good but could be stronger';
    strengthText.style.color = '#ffc107';
  } else {
    strengthBar.classList.add('strong');
    strengthText.textContent = 'Strong - Excellent password!';
    strengthText.style.color = '#28a745';
  }
  
  const termsAgreed = document.getElementById('agreeTerms').checked;
  signupBtn.disabled = strength < 3 || !termsAgreed;
}

//====== DASHBOARD FUNCTIONS ======
function loadDashboard() {
  const isHardcodedAdmin = currentUserId && currentUserId.startsWith("HARDCODED_ADMIN_");
  const displayRole = isHardcodedAdmin ? "ADMIN (HARDCODED)" : role.toUpperCase();
  document.getElementById("roleTitle").innerHTML = displayRole + " DASHBOARD" + (isHardcodedAdmin ? ' <span class="admin-badge">HARDCODED</span>' : '');
  
  const menu = document.getElementById("menu");
  menu.innerHTML = "";
  
  let items = [];
  
  if(role === "teacher") {
    items = [
      {name: "Attendance", icon: "📅"},
      {name: "Subject Schedule", icon: "📚"},
      {name: "My Info", icon: "👤"},
      {name: "Bulletin Board", icon: "📢"},
      {name: "Grades", icon: "📊"},
      {name: "Report Cards", icon: "📋"},
      {name: "Assignments", icon: "📝"},
      {name: "Quizzes", icon: "❓"},
      {name: "Course Materials", icon: "📖"},
      {name: "Messages", icon: "💬"},
      {name: "Conference Schedule", icon: "📅"},
      {name: "Behavior Reports", icon: "📋"},
      {name: "My Planner", icon: "🗓️"},
      {name: "Emergency Numbers", icon: "🚨"},
      {name: "School Map", icon: "🗺️"},
      {name: "Settings", icon: "⚙️"}
    ];
  }
  else if(role === "student") {
    items = [
      {name: "Attendance", icon: "📅"},
      {name: "Subject Schedule", icon: "📚"},
      {name: "My Info", icon: "👤"},
      {name: "Bulletin Board", icon: "📢"},
      {name: "Grades", icon: "📊"},
      {name: "Transcript", icon: "📜"},
      {name: "Assignments", icon: "📝"},
      {name: "Quizzes", icon: "❓"},
      {name: "Course Materials", icon: "📖"},
      {name: "QR Code", icon: "🔳"},
      {name: "Messages", icon: "💬"},
      {name: "My Mood", icon: "😊"},
      {name: "Honor Roll", icon: "🏆"},
      {name: "Payments", icon: "💳"},
      {name: "Emergency Numbers", icon: "🚨"},
      {name: "School Map", icon: "🗺️"},
      {name: "Settings", icon: "⚙️"}
    ];
  }
  else if(role === "parent") {
    items = [
      {name: "Child Attendance", icon: "📅"},
      {name: "Child Grades", icon: "📊"},
      {name: "Child Schedule", icon: "📚"},
      {name: "My Info", icon: "👤"},
      {name: "Bulletin Board", icon: "📢"},
      {name: "Messages", icon: "💬"},
      {name: "Conference Booking", icon: "📅"},
      {name: "Progress Reports", icon: "📈"},
      {name: "Behavior Reports", icon: "📋"},
      {name: "Payments", icon: "💳"},
      {name: "Permission Slips", icon: "📝"},
      {name: "Emergency Numbers", icon: "🚨"},
      {name: "School Map", icon: "🗺️"},
      {name: "Settings", icon: "⚙️"}
    ];
  }
  else if(role === "admin") {
    items = [
      {name: "Student Approval", icon: "✅"},
      {name: "Create Teacher", icon: "👨‍🏫"},
      {name: "All Students", icon: "👨‍🎓"},
      {name: "Parent Accounts", icon: "👪"},
      {name: "Manage Users", icon: "⚙️"},
      {name: "Enrollment", icon: "📝"},
      {name: "Class Scheduling", icon: "📅"},
      {name: "Honor Roll", icon: "🏆"},
      {name: "Analytics", icon: "📊"},
      {name: "Bulletin Board", icon: "📢"},
      {name: "Emergency Numbers", icon: "🚨"},
      {name: "School Map", icon: "🗺️"},
      {name: "Settings", icon: "⚙️"}
    ];
  }

  menu.innerHTML = '<div class="menu-header"><h3>🎓 DSHS Menu</h3><p>👤 ' + currentUser + (isHardcodedAdmin ? ' <span class="admin-badge">ADMIN</span>' : '') + '</p></div>';
  
  items.forEach(function(item) {
    const btn = document.createElement("button");
    btn.innerHTML = '<span class="tab-icon">' + item.icon + '</span> ' + item.name;
    btn.onclick = function() {
      toggleMenu();
      loadSection(item.name);
    };
    menu.appendChild(btn);
  });

  const logoutBtn = document.createElement("button");
  logoutBtn.innerHTML = '<span class="tab-icon">🚪</span> Logout';
  logoutBtn.className = "logout";
  logoutBtn.onclick = function() {
    toggleMenu();
    logout();
  };
  menu.appendChild(logoutBtn);
  
  updateNotificationBadge();
}

//====== SECTION LOADING FUNCTIONS ======
async function loadSection(tab) {
  // Clear previous section listeners
  unsubscribers.forEach(unsub => {
    try { unsub(); } catch(e) { console.error('Error unsubscribing:', e); }
  });
  unsubscribers = [];

  const content = document.getElementById("content");
  content.innerHTML = "";
  const section = document.createElement("div");
  section.className = "section";

  //------ ATTENDANCE ------
  if(tab === "Attendance" || tab === "Child Attendance") {
    section.innerHTML = "<h3>📅 Attendance</h3>";
    
    let studentName = currentUser;
    if(role === "teacher") {
      // Get teacher's section students from Firebase
      const students = await getCollectionData('users', [
        window.firebaseFns.where('role', '==', 'student'),
        window.firebaseFns.where('approved', '==', true)
      ]);
      
      const teacherSection = currentUserData.sectionHandled;
      const sectionStudents = students.filter(s => s.section === teacherSection);
      
      const selectStudent = document.createElement("select");
      selectStudent.id = "attendanceStudentSelect";
      sectionStudents.forEach(function(s){
        const opt = document.createElement("option");
        opt.value = s.name;
        opt.innerText = s.name;
        selectStudent.appendChild(opt);
      });
      section.appendChild(selectStudent);
      if(sectionStudents.length > 0) studentName = sectionStudents[0].name;
      
      selectStudent.onchange = function() {
        studentName = this.value;
        renderAttendanceCalendar(section, studentName);
      };
    } else if(role === "parent") {
      studentName = currentUserData.childName || currentUser;
    }
    
    const dateInput = document.createElement("input");
    dateInput.type = "month";
    dateInput.value = new Date().toISOString().split("T")[0].substring(0, 7);
    section.appendChild(dateInput);
    
    content.appendChild(section);
    renderAttendanceCalendar(section, studentName);
    
    // QR Scanner for teachers
    if(role === "teacher") {
      const scannerDiv = document.createElement("div");
      scannerDiv.id = "qr-scanner";
      scannerDiv.className = "qr-scanner-container";
      scannerDiv.style.marginTop = "20px";
      section.appendChild(scannerDiv);
      
      const scannerResult = document.createElement("div");
      scannerResult.id = "scanner-result";
      scannerResult.className = "scanner-result";
      scannerResult.style.display = "none";
      section.appendChild(scannerResult);
      
      // Initialize scanner with delay to ensure DOM is ready
      setTimeout(function(){
        initQRScanner(scannerDiv, section, studentName);
      }, 500);
    }
  }
  
  //------ GRADES ------
  else if(tab === "Grades" || tab === "Child Grades") {
    section.innerHTML = "<h3>📊 Grades</h3>";
    
    // Subscribe to real-time grades updates
    const gradesUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'grades'),
      (snapshot) => {
        const gradesData = {};
        snapshot.docs.forEach(doc => {
          gradesData[doc.id] = doc.data();
        });
        window.realtimeGrades = gradesData;
        if(document.getElementById('gradesTable')) {
          const studentSelect = document.getElementById('gradesStudentSelect');
          const studentName = studentSelect ? studentSelect.value : currentUser;
          renderGradesTable(section, studentName);
        }
      }
    );
    unsubscribers.push(gradesUnsubscribe);
    
    // Semester Selector
    const semSelector = document.createElement("div");
    semSelector.className = "sem-selector";
    semSelector.innerHTML = `
      <button class="sem-btn active" onclick="selectSemester(1, this)">1st Semester</button>
      <button class="sem-btn" onclick="selectSemester(2, this)">2nd Semester</button>
    `;
    section.appendChild(semSelector);
    
    // Quarter Selector
    const quarterSelector = document.createElement("div");
    quarterSelector.className = "quarter-selector";
    quarterSelector.id = "quarterSelector";
    quarterSelector.innerHTML = `
      <button class="quarter-btn active" onclick="selectQuarter(1, this)">1st Quarter</button>
      <button class="quarter-btn" onclick="selectQuarter(2, this)">2nd Quarter</button>
    `;
    section.appendChild(quarterSelector);
    
    // Grade History Toggle
    const historyToggle = document.createElement('label');
    historyToggle.style.cssText = 'display: flex; align-items: center; gap: 10px; margin: 15px 0; cursor: pointer;';
    historyToggle.innerHTML = '<input type="checkbox" id="showHistory" style="width: auto;" onchange="toggleGradeHistory()"> Show Grade History';
    section.appendChild(historyToggle);
    
    let studentName = currentUser;
    if(role === "teacher") {
      const students = await getCollectionData('users', [
        window.firebaseFns.where('role', '==', 'student'),
        window.firebaseFns.where('approved', '==', true)
      ]);
      
      const teacherSection = currentUserData.sectionHandled;
      const sectionStudents = students.filter(s => s.section === teacherSection);
      
      const selectStudent = document.createElement("select");
      selectStudent.id = "gradesStudentSelect";
      sectionStudents.forEach(function(s){
        const opt = document.createElement("option");
        opt.value = s.name;
        opt.innerText = s.name;
        selectStudent.appendChild(opt);
      });
      section.appendChild(selectStudent);
      if(sectionStudents.length > 0) studentName = sectionStudents[0].name;
      
      selectStudent.onchange = function() {
        studentName = this.value;
        renderGradesTable(section, studentName);
      };
    } else if(role === "parent") {
      studentName = currentUserData.childName || currentUser;
    }
    
    content.appendChild(section);
    renderGradesTable(section, studentName);
  }
  
  //------ REPORT CARDS (Teacher) ------
  else if(tab === "Report Cards" && role === "teacher") {
    section.innerHTML = "<h3>📋 Report Cards</h3>";
    section.innerHTML += "<p>Generate official DepEd-style report cards for students.</p>";
    
    const students = await getCollectionData('users', [
      window.firebaseFns.where('role', '==', 'student'),
      window.firebaseFns.where('approved', '==', true)
    ]);
    
    const teacherSection = currentUserData.sectionHandled;
    const sectionStudents = students.filter(s => s.section === teacherSection);
    const sections = [...new Set(sectionStudents.map(s => s.section))];
    
    const sectionSelect = document.createElement('select');
    sectionSelect.innerHTML = '<option value="">Select Section</option>';
    sections.forEach(sec => {
      sectionSelect.innerHTML += `<option value="${sec}">${sec}</option>`;
    });
    section.appendChild(sectionSelect);
    
    const generateBtn = document.createElement('button');
    generateBtn.innerHTML = '📄 Generate Report Cards';
    generateBtn.style.cssText = 'background: linear-gradient(135deg, var(--main-red) 0%, var(--main-blue) 100%); color: white; margin-top: 15px;';
    generateBtn.onclick = () => generateReportCards(sectionSelect.value, sectionStudents);
    section.appendChild(generateBtn);
    
    const reportContainer = document.createElement('div');
    reportContainer.id = 'reportCardsContainer';
    section.appendChild(reportContainer);
    
    content.appendChild(section);
  }
  
  //------ TRANSCRIPT (Grade 12 Students) ------
  else if(tab === "Transcript" && role === "student") {
    if(currentUserData.gradeLevel !== "12") {
      section.innerHTML = "<h3>📜 Transcript of Records</h3><p>⚠️ Transcripts are only available for Grade 12 students.</p>";
    } else {
      section.innerHTML = "<h3>📜 Transcript of Records</h3>";
      section.innerHTML += "<p>Official transcript for college/university applications.</p>";
      
      // Subscribe to grades for real-time updates
      const gradesUnsubscribe = window.firebaseFns.onSnapshot(
        window.firebaseFns.doc(db, 'grades', currentUserData.name),
        (doc) => {
          const grades = doc.exists() ? doc.data() : {};
          renderTranscript(grades);
        }
      );
      unsubscribers.push(gradesUnsubscribe);
      
      const transcriptDiv = document.createElement('div');
      transcriptDiv.id = 'transcriptContainer';
      transcriptDiv.className = 'report-card';
      section.appendChild(transcriptDiv);
      
      const downloadBtn = document.createElement('button');
      downloadBtn.innerHTML = '⬇️ Download PDF';
      downloadBtn.style.cssText = 'background: #28a745; color: white; margin-top: 20px;';
      downloadBtn.onclick = () => downloadTranscriptPDF(currentUserData);
      section.appendChild(downloadBtn);
    }
    content.appendChild(section);
  }
  
  //------ ASSIGNMENTS ------
  else if(tab === "Assignments") {
    section.innerHTML = "<h3>📝 Assignments</h3>";
    
    // Subscribe to real-time assignments
    const assignmentsUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'assignments'),
      (snapshot) => {
        const assignments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        window.realtimeAssignments = assignments;
        if(document.getElementById('assignmentsContainer')) {
          renderAssignments();
        }
      }
    );
    unsubscribers.push(assignmentsUnsubscribe);
    
    // Subscribe to submissions
    const submissionsUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'submissions'),
      (snapshot) => {
        const submissions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        window.realtimeSubmissions = submissions;
        if(document.getElementById('assignmentsContainer')) {
          renderAssignments();
        }
      }
    );
    unsubscribers.push(submissionsUnsubscribe);
    
    const container = document.createElement('div');
    container.id = 'assignmentsContainer';
    section.appendChild(container);
    
    if(role === "teacher") {
      section.innerHTML += `
        <div style="margin-bottom: 20px;">
          <button onclick="showCreateAssignment()" style="background: #28a745; color: white; width: auto;">➕ Create Assignment</button>
        </div>
        <div id="createAssignmentForm" style="display: none; background: #f8f9fa; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
          <input type="text" id="assignmentTitle" placeholder="Assignment Title">
          <textarea id="assignmentDesc" placeholder="Description" rows="3"></textarea>
          <select id="assignmentSubject">
            <option value="3I's">3I's</option>
            <option value="Genchem 2">Genchem 2</option>
            <option value="P6 2">P6 2</option>
            <option value="Perdev">Perdev</option>
            <option value="CPAR">CPAR</option>
            <option value="Entrepreneurship">Entrepreneurship</option>
          </select>
          <input type="date" id="assignmentDue">
          <input type="number" id="assignmentPoints" placeholder="Total Points" value="100">
          <input type="file" id="assignmentFile" style="width: auto;">
          <button onclick="createAssignment()" style="background: var(--main-blue); color: white; margin-top: 10px;">✅ Create</button>
        </div>
      `;
    }
    
    renderAssignments();
    content.appendChild(section);
  }
  
  //------ QUIZZES ------
  else if(tab === "Quizzes") {
    section.innerHTML = "<h3>❓ Quizzes & Exams</h3>";
    
    // Subscribe to real-time quizzes
    const quizzesUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'quizzes'),
      (snapshot) => {
        const quizzes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        window.realtimeQuizzes = quizzes;
        if(document.getElementById('quizzesContainer')) {
          renderQuizzes();
        }
      }
    );
    unsubscribers.push(quizzesUnsubscribe);
    
    // Subscribe to quiz results
    const resultsUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'quizResults'),
      (snapshot) => {
        const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        window.realtimeQuizResults = results;
        if(document.getElementById('quizzesContainer')) {
          renderQuizzes();
        }
      }
    );
    unsubscribers.push(resultsUnsubscribe);
    
    const container = document.createElement('div');
    container.id = 'quizzesContainer';
    section.appendChild(container);
    
    if(role === "teacher") {
      section.innerHTML += `
        <button onclick="showCreateQuiz()" style="background: #28a745; color: white; width: auto; margin-bottom: 20px;">➕ Create Quiz</button>
        <div id="createQuizForm" style="display: none; background: #f8f9fa; padding: 20px; border-radius: 10px;">
          <input type="text" id="quizTitle" placeholder="Quiz Title">
          <select id="quizSubject">
            <option value="3I's">3I's</option>
            <option value="Genchem 2">Genchem 2</option>
            <option value="P6 2">P6 2</option>
            <option value="Perdev">Perdev</option>
            <option value="CPAR">CPAR</option>
            <option value="Entrepreneurship">Entrepreneurship</option>
          </select>
          <input type="number" id="quizDuration" placeholder="Duration (minutes)" value="30">
          <input type="datetime-local" id="quizStart">
          <input type="datetime-local" id="quizEnd">
          <div id="quizQuestions"></div>
          <button onclick="addQuestion()" style="width: auto; background: var(--sub-yellow); color: #333; margin: 10px 5px 10px 0;">➕ Add Question</button>
          <button onclick="saveQuiz()" style="background: #28a745; color: white;">💾 Save Quiz</button>
        </div>
      `;
    }
    
    renderQuizzes();
    content.appendChild(section);
  }
  
  //------ COURSE MATERIALS ------
  else if(tab === "Course Materials" && role === "student") {
    section.innerHTML = "<h3>📖 Course Materials</h3>";
    
    // Subscribe to real-time materials
    const materialsUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'courseMaterials'),
      (snapshot) => {
        const materials = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        window.realtimeMaterials = materials;
        if(document.getElementById('materialsContainer')) {
          renderCourseMaterials();
        }
      }
    );
    unsubscribers.push(materialsUnsubscribe);
    
    const container = document.createElement('div');
    container.id = 'materialsContainer';
    section.appendChild(container);
    
    renderCourseMaterials();
    content.appendChild(section);
  }
  
  //------ MESSAGES ------
  else if(tab === "Messages") {
    section.innerHTML = "<h3>💬 Messages</h3>";
    
    // Subscribe to real-time messages
    const messagesUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'messages'),
      (snapshot) => {
        const messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        window.realtimeMessages = messages;
        if(currentContact) {
          loadMessages(currentContact.username);
        }
      }
    );
    unsubscribers.push(messagesUnsubscribe);
    
    const messagingContainer = document.createElement('div');
    messagingContainer.className = 'messaging-container';
    
    const contactsList = document.createElement('div');
    contactsList.className = 'contacts-list';
    
    let contacts = [];
    if(role === 'teacher') {
      const students = await getCollectionData('users', [
        window.firebaseFns.where('role', '==', 'student'),
        window.firebaseFns.where('approved', '==', true)
      ]);
      const teacherSection = currentUserData.sectionHandled;
      const sectionStudents = students.filter(s => s.section === teacherSection);
      
      sectionStudents.forEach(s => {
        contacts.push({name: s.name, username: s.name, type: 'student', avatar: '👨‍🎓'});
      });
    } else if(role === 'parent') {
      const teachers = await getCollectionData('users', [
        window.firebaseFns.where('role', '==', 'teacher')
      ]);
      teachers.forEach(t => {
        contacts.push({name: t.name, username: t.name, type: 'teacher', avatar: '👨‍🏫'});
      });
    } else if(role === 'student') {
      const teachers = await getCollectionData('users', [
        window.firebaseFns.where('role', '==', 'teacher')
      ]);
      teachers.forEach(t => {
        contacts.push({name: t.name, username: t.name, type: 'teacher', avatar: '👨‍🏫'});
      });
    }
    
    contacts.forEach((contact, index) => {
      const contactDiv = document.createElement('div');
      contactDiv.className = 'contact-item' + (index === 0 ? ' active' : '');
      contactDiv.innerHTML = `
        <div class="contact-avatar">${contact.avatar}</div>
        <div>
          <div style="font-weight: bold;">${contact.name}</div>
          <div style="font-size: 12px; color: #666;">${contact.type}</div>
        </div>
      `;
      contactDiv.onclick = () => selectContact(contact, contactDiv);
      contactsList.appendChild(contactDiv);
    });
    
    messagingContainer.appendChild(contactsList);
    
    const chatArea = document.createElement('div');
    chatArea.className = 'chat-area';
    chatArea.id = 'chatArea';
    
    chatArea.innerHTML = `
      <div class="chat-header" id="chatHeader">Select a contact to start messaging</div>
      <div class="chat-messages" id="chatMessages"></div>
      <div class="chat-input-area">
        <input type="text" id="messageInput" placeholder="Type your message..." disabled>
        <button onclick="sendMessage()" id="sendBtn" disabled style="width: auto; background: var(--main-blue); color: white;">📤</button>
      </div>
    `;
    
    messagingContainer.appendChild(chatArea);
    section.appendChild(messagingContainer);
    
    if(contacts.length > 0) {
      setTimeout(() => selectContact(contacts[0], contactsList.firstChild), 100);
    }
    
    content.appendChild(section);
  }
  
  //------ CONFERENCE SCHEDULING ------
  else if(tab === "Conference Schedule" || tab === "Conference Booking") {
    section.innerHTML = "<h3>📅 Parent-Teacher Conference</h3>";
    
    // Subscribe to real-time conferences
    const conferencesUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'conferences'),
      (snapshot) => {
        const conferences = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        window.realtimeConferences = conferences;
        if(document.getElementById('conferencesContainer')) {
          renderConferences();
        }
      }
    );
    unsubscribers.push(conferencesUnsubscribe);
    
    const container = document.createElement('div');
    container.id = 'conferencesContainer';
    section.appendChild(container);
    
    if(role === "teacher") {
      section.innerHTML += `
        <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
          <h4>Set Available Slots</h4>
          <input type="date" id="conferenceDate">
          <input type="time" id="conferenceStart">
          <input type="time" id="conferenceEnd">
          <input type="number" id="slotDuration" placeholder="Slot duration (minutes)" value="30">
          <button onclick="generateSlots()" style="background: #28a745; color: white; margin-top: 10px;">➕ Generate Slots</button>
        </div>
      `;
    }
    
    renderConferences();
    content.appendChild(section);
  }
  
  //------ BEHAVIOR REPORTS ------
  else if(tab === "Behavior Reports") {
    section.innerHTML = "<h3>📋 Behavioral Records</h3>";
    
    // Subscribe to real-time behavior logs
    const behaviorUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'behaviorLog'),
      (snapshot) => {
        const logs = {};
        snapshot.docs.forEach(doc => {
          logs[doc.id] = doc.data().entries || [];
        });
        window.realtimeBehaviorLog = logs;
        if(document.getElementById('behaviorContainer')) {
          renderBehaviorReports();
        }
      }
    );
    unsubscribers.push(behaviorUnsubscribe);
    
    const container = document.createElement('div');
    container.id = 'behaviorContainer';
    section.appendChild(container);
    
    if(role === "teacher") {
      const students = await getCollectionData('users', [
        window.firebaseFns.where('role', '==', 'student'),
        window.firebaseFns.where('approved', '==', true)
      ]);
      
      const teacherSection = currentUserData.sectionHandled;
      const sectionStudents = students.filter(s => s.section === teacherSection);
      
      const studentSelect = document.createElement('select');
      studentSelect.id = 'behaviorStudent';
      sectionStudents.forEach(s => {
        studentSelect.innerHTML += `<option value="${s.name}">${s.name}</option>`;
      });
      section.appendChild(studentSelect);
      
      section.innerHTML += `
        <select id="behaviorType">
          <option value="merit">Merit (+)</option>
          <option value="demerit">Demerit (-)</option>
        </select>
        <input type="number" id="behaviorPoints" placeholder="Points" value="1" min="1" max="10">
        <input type="text" id="behaviorReason" placeholder="Reason/Description">
        <button onclick="addBehaviorRecord()" style="background: #28a745; color: white; margin-top: 10px;">➕ Add Record</button>
      `;
    }
    
    renderBehaviorReports();
    content.appendChild(section);
  }
  
  //------ HONOR ROLL ------
  else if(tab === "Honor Roll") {
    section.innerHTML = "<h3>🏆 Honor Roll & Academic Excellence</h3>";
    
    // Subscribe to real-time grades for honor roll
    const gradesUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'grades'),
      (snapshot) => {
        const gradesData = {};
        snapshot.docs.forEach(doc => {
          gradesData[doc.id] = doc.data();
        });
        window.realtimeGrades = gradesData;
        if(document.getElementById('honorRollContainer')) {
          renderHonorRoll();
        }
      }
    );
    unsubscribers.push(gradesUnsubscribe);
    
    // Subscribe to students
    const studentsUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.query(
        window.firebaseFns.collection(db, 'users'),
        window.firebaseFns.where('role', '==', 'student'),
        window.firebaseFns.where('approved', '==', true)
      ),
      (snapshot) => {
        const students = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        window.realtimeStudents = students;
        if(document.getElementById('honorRollContainer')) {
          renderHonorRoll();
        }
      }
    );
    unsubscribers.push(studentsUnsubscribe);
    
    const container = document.createElement('div');
    container.id = 'honorRollContainer';
    section.appendChild(container);
    
    renderHonorRoll();
    content.appendChild(section);
  }
  
  //------ PAYMENTS ------
  else if(tab === "Payments") {
    section.innerHTML = "<h3>💳 Payments & Financial Records</h3>";
    
    // Subscribe to real-time payments
    const paymentsUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.collection(db, 'payments'),
      (snapshot) => {
        const payments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        window.realtimePayments = payments;
        if(document.getElementById('paymentsContainer')) {
          renderPayments();
        }
      }
    );
    unsubscribers.push(paymentsUnsubscribe);
    
    const container = document.createElement('div');
    container.id = 'paymentsContainer';
    section.appendChild(container);
    
    renderPayments();
    content.appendChild(section);
  }
  
  //------ SETTINGS ------
  else if(tab === "Settings") {
    section.innerHTML = `
      <h3>⚙️ Settings</h3>
      <div class="settings-section">
        <h4>🎨 Appearance</h4>
        <div style="display: flex; justify-content: space-between; align-items: center; margin: 15px 0;">
          <div>
            <strong>Dark Mode</strong>
            <p style="margin: 5px 0; font-size: 13px; color: #666;">Easier on the eyes</p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggleDarkMode" onchange="toggleDarkMode()" ${localStorage.getItem('darkMode') === 'true' ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
      </div>
      <div class="settings-section">
        <h4>🔔 Notifications</h4>
        <div style="display: flex; justify-content: space-between; align-items: center; margin: 15px 0;">
          <div>
            <strong>Push Notifications</strong>
            <p style="margin: 5px 0; font-size: 13px; color: #666;">Get notified about updates</p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="togglePushNotif" checked>
            <span class="slider"></span>
          </label>
        </div>
      </div>
      <div class="settings-section">
        <h4>🌐 Language</h4>
        <select id="languageSelect" onchange="changeLanguage()">
          <option value="en">English</option>
          <option value="fil">Filipino</option>
          <option value="ceb">Cebuano</option>
        </select>
      </div>
    `;
    content.appendChild(section);
  }
  
  //------ SUBJECT SCHEDULE - UPDATED WITH WEEKLY FORMAT ------
  else if(tab === "Subject Schedule" || tab === "Child Schedule") {
    section.innerHTML = "<h3>📚 Weekly Subject Schedule</h3>";
    
    let studentName = currentUser;
    let userSection = currentUserData.section;
    
    if(role === "parent") {
      studentName = currentUserData.childName || currentUser;
      userSection = currentUserData.childSection;
    } else if(role === "teacher") {
      userSection = currentUserData.sectionHandled;
    }
    
    // Subscribe to schedule updates
    const scheduleUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.doc(db, 'schedules', userSection || 'default'),
      (doc) => {
        const scheduleData = doc.exists() ? doc.data() : null;
        window.realtimeSchedule = scheduleData;
        if(document.getElementById('scheduleTable')) {
          renderScheduleTable(userSection);
        }
      }
    );
    unsubscribers.push(scheduleUnsubscribe);
    
    // Create weekly schedule table
    const scheduleDiv = document.createElement("div");
    scheduleDiv.id = 'scheduleTable';
    scheduleDiv.className = "weekly-schedule";
    section.appendChild(scheduleDiv);
    
    renderScheduleTable(userSection);
    
    // Add legend
    const legend = document.createElement("div");
    legend.style.marginTop = "20px";
    legend.style.padding = "15px";
    legend.style.background = "#f8f9fa";
    legend.style.borderRadius = "8px";
    legend.innerHTML = `
      <h4>📋 Schedule Legend</h4>
      <p><span style="display: inline-block; width: 20px; height: 20px; background: #fff3cd; margin-right: 10px; vertical-align: middle;"></span> Recess</p>
      <p><span style="display: inline-block; width: 20px; height: 20px; background: #d4edda; margin-right: 10px; vertical-align: middle;"></span> Lunch</p>
    `;
    section.appendChild(legend);
    
    // Management controls for teachers/admins
    if(role === "teacher" || role === "admin") {
      section.innerHTML += "<h4>Manage Schedule</h4>";
      section.innerHTML += `
        <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin-top: 15px;">
          <p><strong>Current Section:</strong> ${userSection}</p>
          <p style="font-size: 13px; color: #666; margin-top: 10px;">
            💡 Tip: The schedule is automatically generated based on your section. 
            To customize subjects, use the Subject Management below.
          </p>
        </div>
      `;
      
      // Subject management
      section.innerHTML += "<h4 style='margin-top: 25px;'>Subject Management</h4>";
      const subjects = ["3I's","Genchem 2","P6 2","Perdev","CPAR","Entrepreneurship"];
      subjects.forEach(function(sub, index){
        const item = document.createElement("div");
        item.className = "subject-item";
        item.innerHTML = '<input type="text" value="' + sub + '" onchange="updateSubject(' + index + ', this.value)">' +
          '<input type="text" placeholder="Time" onchange="updateScheduleTime('' + sub + '', this.value)">' +
          '<button onclick="deleteSubject(' + index + ')" style="width:auto;background:#dc3545;color:white;">🗑️ Delete</button>';
        section.appendChild(item);
      });
      
      const addDiv = document.createElement("div");
      addDiv.className = "subject-item";
      addDiv.innerHTML = '<input type="text" id="newSubjectName" placeholder="New Subject">' +
        '<input type="text" id="newSubjectTime" placeholder="Time">' +
        '<button onclick="addSubject()" style="width:auto;background:#28a745;color:white;">➕ Add</button>';
      section.appendChild(addDiv);
    }
    
    content.appendChild(section);
  }

  //------ QR CODE ------
  else if(tab === "QR Code" && role === "student") {
    section.innerHTML = "<h3>🔳 Your QR Code</h3>";
    const qrDiv = document.createElement("div");
    qrDiv.id = "qr-code";
    qrDiv.style.textAlign = "center";
    qrDiv.style.padding = "20px";
    section.appendChild(qrDiv);
    
    const qrCodeData = currentUser + "-" + new Date().toISOString().split("T")[0];
    setTimeout(() => {
      try {
        new QRCode(qrDiv, {
          text: qrCodeData,
          width: 200,
          height: 200,
          colorDark: "#003366",
          colorLight: "#ffffff"
        });
      } catch(e) {
        console.error('QR Code generation error:', e);
        qrDiv.innerHTML = '<p>Error generating QR code</p>';
      }
    }, 100);
    
    section.innerHTML += "<p style='text-align:center;margin-top:15px;'>📱 Scan this QR code for attendance</p>";
    
    // Subscribe to real-time attendance
    const attendanceUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.doc(db, 'attendance', currentUser),
      (doc) => {
        const attendanceData = doc.exists() ? doc.data() : {};
        if(document.getElementById('attendanceStats')) {
          renderAttendanceStats(attendanceData);
        }
      }
    );
    unsubscribers.push(attendanceUnsubscribe);
    
    const perfBox = document.createElement("div");
    perfBox.id = 'attendanceStats';
    perfBox.className = "performance-box";
    section.appendChild(perfBox);
    
    renderAttendanceStats({});
    
    content.appendChild(section);
  }

  //------ MY INFO - WITH PHOTO UPLOAD ------
  else if(tab === "My Info") {
    section.innerHTML = "<h3>👤 My Information</h3>";
    
    const user = currentUserData;
    if(user) {
      const initials = user.name ? user.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() : '👤';
      const photoURL = user.photoURL || null;
      
      section.innerHTML += `
        <div style="text-align: center; margin-bottom: 20px;">
          <div class="id-card-photo" id="profilePhoto" style="width: 120px; height: 120px; margin: 0 auto 15px; font-size: 48px; display: flex; align-items: center; justify-content: center; background: ${photoURL ? 'transparent' : 'linear-gradient(135deg, var(--main-red) 0%, var(--main-blue) 100%)'}; color: white; position: relative; overflow: hidden;">
            ${photoURL ? `<img src="${photoURL}" style="width: 100%; height: 100%; object-fit: cover;" />` : initials}
            <div onclick="triggerPhotoUpload()" style="position: absolute; bottom: 0; right: 0; background: rgba(0,0,0,0.7); color: white; padding: 5px 10px; font-size: 12px; cursor: pointer; border-radius: 20px 0 0 0;">
              📷 Change
            </div>
          </div>
          <input type="file" id="photoUpload" style="display: none;" accept="image/*" onchange="handlePhotoUpload(event)">
          <p style="font-size: 12px; color: #666; margin-top: 5px;">Click "Change" to upload photo</p>
        </div>
        <div class="id-card-info" style="background: #f8f9fa; color: #333; padding: 20px; border-radius: 10px;">
          <p><strong>Name:</strong> ${user.name || '-'}</p>
          <p><strong>Email:</strong> ${user.email || '-'}</p>
          <p><strong>Role:</strong> ${user.role || '-'}</p>
          <p><strong>Section:</strong> ${user.section || user.sectionHandled || '-'}</p>
          <p><strong>Track:</strong> ${user.track || '-'}</p>
          <p><strong>Strand:</strong> ${user.strand || '-'}</p>
          <p><strong>Grade Level:</strong> ${user.gradeLevel || '-'}</p>
          ${user.teacherName ? `<p><strong>Adviser:</strong> ${user.teacherName}</p>` : ''}
        </div>
      `;
    }
    
    content.appendChild(section);
  }

  //------ BULLETIN BOARD ------
  else if(tab === "Bulletin Board") {
    section.innerHTML = "<h3>📢 Bulletin Board</h3>";
    
    const board = document.createElement('div');
    board.id = 'bulletinBoard';
    section.appendChild(board);
    
    subscribeToCollection('bulletinBoard', (items) => {
      board.innerHTML = '';
      if(items.length === 0) {
        board.innerHTML = '<p>No announcements yet.</p>';
      } else {
        items.forEach(item => {
          const div = document.createElement('div');
          div.style.cssText = 'padding: 15px; border-bottom: 1px solid #ddd; margin-bottom: 10px; background: #f8f9fa; border-radius: 8px;';
          div.innerHTML = `
            <p>${item.content}</p>
            <small style="color: #666;">By ${item.author || 'Unknown'} • ${item.createdAt?.toDate ? item.createdAt.toDate().toLocaleString() : 'Just now'}</small>
          `;
          board.appendChild(div);
        });
      }
    }, [window.firebaseFns.orderBy('createdAt', 'desc')]);
    
    if(role === "teacher" || role === "admin") {
      const input = document.createElement('input');
      input.id = 'newAnnouncement';
      input.placeholder = 'Type new announcement...';
      section.appendChild(input);
      
      const btn = document.createElement('button');
      btn.innerText = '➕ Add Announcement';
      btn.style.cssText = 'background: linear-gradient(135deg, #8B0000 0%, #003366 100%); color: white; margin-top: 10px;';
      btn.onclick = async () => {
        const text = input.value.trim();
        if(text) {
          await addDocument('bulletinBoard', {
            content: text,
            author: currentUser,
            authorId: currentUserId,
            authorRole: role
          });
          input.value = '';
        }
      };
      section.appendChild(btn);
    }
    
    content.appendChild(section);
  }
  
  //------ ADMIN FUNCTIONS ------
  else if(role === "admin") {
    //------ STUDENT APPROVAL ------
    if(tab === "Student Approval") {
      section.innerHTML = "<h3>✅ Approve Students</h3>";
      
      // Subscribe to real-time pending students
      const pendingUnsubscribe = window.firebaseFns.onSnapshot(
        window.firebaseFns.query(
          window.firebaseFns.collection(db, 'users'),
          window.firebaseFns.where('role', '==', 'student'),
          window.firebaseFns.where('approved', '==', false)
        ),
        (snapshot) => {
          const pendingStudents = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          renderPendingStudents(section, pendingStudents);
        }
      );
      unsubscribers.push(pendingUnsubscribe);
      
      content.appendChild(section);
    }
    
    //------ CREATE TEACHER ------
    else if(tab === "Create Teacher") {
      section.innerHTML = "<h3>👨‍🏫 Create Teacher Account</h3>";
      section.innerHTML += `
        <input type="text" id="newTeacherName" placeholder="👤 Full Name">
        <input type="text" id="newTeacherID" placeholder="🆔 Teacher ID">
        <input type="text" id="newTeacherPosition" placeholder="💼 Position">
        <input type="text" id="newTeacherSection" placeholder="🏫 Section Handled">
        <input type="text" id="newTeacherUsername" placeholder="👤 Username">
        <input type="email" id="newTeacherEmail" placeholder="📧 Email">
        <input type="password" id="newTeacherPassword" placeholder="🔒 Password (min 8 chars)">
        <button onclick="createTeacher()" style="background: linear-gradient(135deg, #8B0000 0%, #003366 100%); color: white; padding: 14px;">👨‍🏫 Create Teacher</button>
      `;
      
      content.appendChild(section);
    }
    
    //------ ALL STUDENTS ------
    else if(tab === "All Students") {
      section.innerHTML = "<h3>👨‍🎓 All Students</h3>";
      
      const printControls = document.createElement("div");
      printControls.className = "print-controls";
      printControls.innerHTML = `
        <h4>🖨️ Print ID Cards</h4>
        <p>Check the students you want to print, then click Print Selected.</p>
        <label><input type="checkbox" id="selectAllStudents" onchange="toggleSelectAllStudents()" style="width:auto;"> ✅ Select All</label><br><br>
        <button onclick="printSelectedIDs()" style="background:#28a745;color:white;width:auto;padding:12px 24px;">🖨️ Print Selected</button>
      `;
      section.appendChild(printControls);
      
      // Subscribe to real-time students
      const studentsUnsubscribe = window.firebaseFns.onSnapshot(
        window.firebaseFns.query(
          window.firebaseFns.collection(db, 'users'),
          window.firebaseFns.where('role', '==', 'student'),
          window.firebaseFns.where('approved', '==', true)
        ),
        (snapshot) => {
          const students = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          window.realtimeAllStudents = students;
          if(document.getElementById('studentsContainer')) {
            renderAllStudents();
          }
        }
      );
      unsubscribers.push(studentsUnsubscribe);
      
      const filterSection = document.createElement("select");
      filterSection.id = "filterSection";
      filterSection.innerHTML = "<option value='all'>📋 All Sections</option>";
      section.appendChild(filterSection);
      
      const studentsContainer = document.createElement("div");
      studentsContainer.id = "studentsContainer";
      section.appendChild(studentsContainer);
      
      filterSection.onchange = function(){
        renderAllStudents();
      };
      
      content.appendChild(section);
    }
    
    //------ PARENT ACCOUNTS ------
    else if(tab === "Parent Accounts") {
      section.innerHTML = "<h3>👪 Parent Accounts</h3>";
      section.innerHTML += "<p>📝 These credentials are auto-generated when students sign up.</p>";
      
      // Subscribe to real-time parent accounts
      const parentsUnsubscribe = window.firebaseFns.onSnapshot(
        window.firebaseFns.collection(db, 'parentAccounts'),
        (snapshot) => {
          const parentAccounts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          window.realtimeParentAccounts = parentAccounts;
          if(document.getElementById('parentContainer')) {
            renderParentAccounts();
          }
        }
      );
      unsubscribers.push(parentsUnsubscribe);
      
      const filterSection = document.createElement("select");
      filterSection.id = "filterParentSection";
      filterSection.innerHTML = "<option value='all'>📋 All Sections</option>";
      section.appendChild(filterSection);
      
      const parentContainer = document.createElement("div");
      parentContainer.id = "parentContainer";
      section.appendChild(parentContainer);
      
      filterSection.onchange = function(){
        renderParentAccounts();
      };
      
      content.appendChild(section);
    }
    
    //------ MANAGE USERS ------
    else if(tab === "Manage Users") {
      section.innerHTML = "<h3>⚙️ Manage Users</h3>";
      
      // Subscribe to real-time users
      const usersUnsubscribe = window.firebaseFns.onSnapshot(
        window.firebaseFns.collection(db, 'users'),
        (snapshot) => {
          const allUsers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          renderManageUsers(allUsers);
        }
      );
      unsubscribers.push(usersUnsubscribe);
      
      const container = document.createElement('div');
      container.id = 'manageUsersContainer';
      section.appendChild(container);
      
      content.appendChild(section);
    }
    
    //------ ENROLLMENT ------
    else if(tab === "Enrollment") {
      section.innerHTML = "<h3>📝 Online Enrollment</h3>";
      
      section.innerHTML += `
        <div class="step-indicator">
          <div class="step active" id="step1">1. Personal Info</div>
          <div class="step" id="step2">2. Academic Info</div>
          <div class="step" id="step3">3. Documents</div>
          <div class="step" id="step4">4. Review</div>
        </div>
        
        <div class="enrollment-step active" id="enrollStep1">
          <h4>Personal Information</h4>
          <input type="text" id="enrollLastName" placeholder="Last Name">
          <input type="text" id="enrollFirstName" placeholder="First Name">
          <input type="text" id="enrollMiddleName" placeholder="Middle Name">
          <input type="date" id="enrollBirthdate" placeholder="Birthdate">
          <select id="enrollGender">
            <option value="">Select Gender</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
          </select>
          <button onclick="nextEnrollStep(1)" style="background: var(--main-blue); color: white;">Next ➡️</button>
        </div>
        
        <div class="enrollment-step" id="enrollStep2">
          <h4>Academic Information</h4>
          <select id="enrollTrack">
            <option value="">Select Track</option>
            <option value="Academic">Academic</option>
            <option value="TVL">Technical-Vocational-Livelihood</option>
            <option value="Arts">Arts and Design</option>
            <option value="Sports">Sports</option>
          </select>
          <select id="enrollStrand">
            <option value="">Select Strand</option>
            <option value="STEM">STEM</option>
            <option value="ABM">ABM</option>
            <option value="HUMSS">HUMSS</option>
            <option value="GAS">GAS</option>
          </select>
          <select id="enrollGrade">
            <option value="">Select Grade Level</option>
            <option value="11">Grade 11</option>
            <option value="12">Grade 12</option>
          </select>
          <div style="display: flex; gap: 10px;">
            <button onclick="prevEnrollStep(2)" style="background: #6c757d; color: white; flex: 1;">⬅️ Back</button>
            <button onclick="nextEnrollStep(2)" style="background: var(--main-blue); color: white; flex: 1;">Next ➡️</button>
          </div>
        </div>
        
        <div class="enrollment-step" id="enrollStep3">
          <h4>Required Documents</h4>
          <div class="upload-zone" onclick="document.getElementById('doc1').click()">
            <div>📄</div>
            <p><strong>Click to upload</strong> or drag and drop</p>
            <p style="font-size: 12px; color: #666;">Birth Certificate (PDF, JPG)</p>
            <input type="file" id="doc1" style="display: none;" accept=".pdf,.jpg,.png">
          </div>
          <div class="upload-zone" onclick="document.getElementById('doc2').click()" style="margin-top: 15px;">
            <div>📄</div>
            <p><strong>Click to upload</strong> or drag and drop</p>
            <p style="font-size: 12px; color: #666;">Form 138 (Report Card)</p>
            <input type="file" id="doc2" style="display: none;" accept=".pdf,.jpg,.png">
          </div>
          <div style="display: flex; gap: 10px; margin-top: 15px;">
            <button onclick="prevEnrollStep(3)" style="background: #6c757d; color: white; flex: 1;">⬅️ Back</button>
            <button onclick="nextEnrollStep(3)" style="background: var(--main-blue); color: white; flex: 1;">Next ➡️</button>
          </div>
        </div>
        
        <div class="enrollment-step" id="enrollStep4">
          <h4>Review Application</h4>
          <div id="enrollReview" style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 15px 0;"></div>
          <div style="display: flex; gap: 10px;">
            <button onclick="prevEnrollStep(4)" style="background: #6c757d; color: white; flex: 1;">⬅️ Back</button>
            <button onclick="submitEnrollment()" style="background: #28a745; color: white; flex: 1;">✅ Submit Application</button>
          </div>
        </div>
      `;
      
      content.appendChild(section);
    }
    
    //------ ANALYTICS ------
    else if(tab === "Analytics") {
      section.innerHTML = "<h3>📊 School Analytics Dashboard</h3>";
      
      const container = document.createElement('div');
      container.id = 'analyticsContainer';
      section.appendChild(container);
      
      // Subscribe to real-time analytics
      subscribeToAnalytics((data) => {
        renderAnalytics(data);
      });
      
      content.appendChild(section);
    }
  }
  
  //------ MY PLANNER ------
  else if(tab === "My Planner" && role === "teacher") {
    section.innerHTML = "<h3>📝 My Planner</h3>";
    
    // Subscribe to planner data
    const plannerUnsubscribe = window.firebaseFns.onSnapshot(
      window.firebaseFns.doc(db, 'planners', currentUserId),
      (doc) => {
        const plannerData = doc.exists() ? doc.data() : { daily: [], weekly: [], monthly: [] };
        window.realtimePlanner = plannerData;
        if(document.getElementById('plannerContainer')) {
          renderPlanner();
        }
      }
    );
    unsubscribers.push(plannerUnsubscribe);
    
    const container = document.createElement('div');
    container.id = 'plannerContainer';
    container.className = "planner-container";
    section.appendChild(container);
    
    renderPlanner();
    content.appendChild(section);
  }
  
  //------ MY MOOD ------
  else if(tab === "My Mood" && role === "student") {
    section.innerHTML = "<h3>🤗 My Mood - AI Companion</h3>";
    section.innerHTML += "<p>Share how you're feeling and I'll help you feel better!</p>";
    
    const moodDiv = document.createElement("div");
    moodDiv.className = "mood-selector";
    moodDiv.innerHTML = '<button class="mood-btn" onclick="selectMood('😊')">😊</button>' +
      '<button class="mood-btn" onclick="selectMood('😢')">😢</button>' +
      '<button class="mood-btn" onclick="selectMood('😠')">😠</button>' +
      '<button class="mood-btn" onclick="selectMood('😰')">😰</button>' +
      '<button class="mood-btn" onclick="selectMood('😴')">😴</button>' +
      '<button class="mood-btn" onclick="selectMood('🤗')">🤗</button>';
    section.appendChild(moodDiv);
    
    const chatbox = document.createElement("div");
    chatbox.id = "moodChatbox";
    chatbox.className = "chatbox";
    chatbox.style.background = "#f0f8ff";
    chatbox.innerHTML = '<div class="chat-message chat-ai"><strong>🤗 AI Companion:</strong> Hi! How are you feeling today? You can select a mood above or just tell me what's on your mind.</div>';
    section.appendChild(chatbox);
    
    const input = document.createElement("input");
    input.type = "text";
    input.id = "moodInput";
    input.placeholder = "Tell me what's on your mind...";
    section.appendChild(input);
    
    const sendBtn = document.createElement("button");
    sendBtn.innerText = "💬 Share";
    sendBtn.style.background = "#6c5ce7";
    sendBtn.style.color = "white";
    sendBtn.onclick = function() { sendMoodMessage(); };
    section.appendChild(sendBtn);
    
    section.innerHTML += '<div style="margin-top:18px;padding:15px;background:#fff3cd;border-radius:8px;font-size:13px;">' +
      '<strong>💡 Tips:</strong> Talk about your feelings! I'm here to listen and help.' +
      '</div>';
    
    content.appendChild(section);
  }
  
  //------ EMERGENCY NUMBERS ------
  else if(tab === "Emergency Numbers") {
    section.innerHTML = "<h3>🚨 Emergency Numbers</h3>";
    const numbers = [
      {name:"🚔 PNP DUMINGAG", num:"099859558677"},
      {name:"🔥 BFP DUMINGAG", num:"09300459871"},
      {name:"🏛️ LGU DUMINGAG", num:"09482121024"},
      {name:"🆘 MDRRMO DUMINGAG", num:"09098046609"}
    ];
    numbers.forEach(function(n){
      const div = document.createElement("div");
      div.style.margin = "12px 0";
      div.innerHTML = '<a href="tel:' + n.num + '" style="display:block;padding:18px;background:linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);border-radius:10px;border-left:5px solid #dc3545;text-decoration:none;color:#333;transition:all 0.3s;">' +
        '<strong>' + n.name + '</strong><br>' + n.num + '</a>';
      section.appendChild(div);
    });
    
    content.appendChild(section);
  }
  
  //------ SCHOOL MAP ------
  else if(tab === "School Map") {
    section.innerHTML = "<h3>🗺️ School Map</h3>";
    
    const mapContainer = document.createElement("div");
    mapContainer.className = "school-map-container";
    mapContainer.innerHTML = `
      <h4>🏫 DSHS Campus Layout</h4>
      <img src="https://via.placeholder.com/800x600" alt="DSHS School Map" style="max-width:100%;border-radius:10px;box-shadow:0 4px 15px rgba(0,0,0,0.2);">
      <div class="map-legend">
        <div class="map-legend-item">
          <strong>🏢 Building A</strong>
          Main Entrance & Administration
        </div>
        <div class="map-legend-item">
          <strong>🏫 Building B</strong>
          Classrooms 12-A, 12-B, 12-C
        </div>
        <div class="map-legend-item">
          <strong>🔬 Building C</strong>
          Science Laboratory
        </div>
        <div class="map-legend-item">
          <strong>📚 Building D</strong>
          Library & Computer Room
        </div>
        <div class="map-legend-item">
          <strong>👨‍🏫 Building E</strong>
          Faculty Room
        </div>
        <div class="map-legend-item">
          <strong>🏀 Gymnasium</strong>
          Physical Education Activities
        </div>
        <div class="map-legend-item">
          <strong>🍽️ Cafeteria</strong>
          Student Lounge
        </div>
        <div class="map-legend-item">
          <strong>💼 Guidance Office</strong>
          Counseling Services
        </div>
      </div>
    `;
    section.appendChild(mapContainer);
    
    content.appendChild(section);
  }
  
  //------ DEFAULT ------
  else {
    section.innerHTML = `
      <div class="school-welcome">
        <h2>🏫 ${tab}</h2>
        <p>This feature is coming soon!</p>
      </div>
    `;
    content.appendChild(section);
  }
}

//====== QR SCANNER INITIALIZATION ======
async function initQRScanner(container, section, studentName) {
  try {
    // Check if Html5Qrcode is available
    if(typeof Html5Qrcode === 'undefined') {
      console.error('Html5Qrcode library not loaded');
      container.innerHTML = '<p style="color: red;">QR Scanner library not available. Please refresh the page.</p>';
      return;
    }
    
    // Stop existing scanner if any
    if(html5QrCodeScanner) {
      await html5QrCodeScanner.stop();
      html5QrCodeScanner = null;
    }
    
    html5QrCodeScanner = new Html5Qrcode("qr-scanner");
    
    await html5QrCodeScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 250 },
      function(decodedText){
        handleQRScan(decodedText, section, studentName);
      },
      function(errorMessage){
        // QR scan error - ignore continuous errors
      }
    );
    
    console.log('QR Scanner started successfully');
  } catch(err) {
    console.error("Scanner initialization error:", err);
    container.innerHTML = '<p style="color: red;">Camera access denied or not available. Please check permissions.</p>';
  }
}

async function handleQRScan(decodedText, section, studentName) {
  try {
    const parts = decodedText.split("-");
    const scannedStudent = parts[0];
    const today = new Date().toISOString().split("T")[0];
    
    // Save attendance to Firebase
    await saveAttendance(scannedStudent, today, "P");
    
    const resultDiv = document.getElementById("scanner-result");
    if(resultDiv) {
      resultDiv.style.display = "block";
      resultDiv.className = "scanner-result success";
      resultDiv.innerHTML = "✅ Marked " + scannedStudent + " present on " + today;
    }
    
    renderAttendanceCalendar(section, studentName);
    addNotification('You were marked present on ' + today, 'attendance', scannedStudent);
    
    // Stop scanner after successful scan
    if(html5QrCodeScanner) {
      await html5QrCodeScanner.stop();
      html5QrCodeScanner = null;
    }
  } catch(error) {
    console.error('QR Scan handling error:', error);
  }
}

//====== RENDER FUNCTIONS FOR REAL-TIME DATA ======
function renderAssignments() {
  const container = document.getElementById('assignmentsContainer');
  if(!container) return;
  
  container.innerHTML = '';
  
  const assignments = window.realtimeAssignments || [];
  const submissions = window.realtimeSubmissions || [];
  
  if(role === "teacher") {
    const teacherAssignments = assignments.filter(a => a.teacher === currentUser);
    if(teacherAssignments.length === 0) {
      container.innerHTML = "<p>No assignments created yet.</p>";
    } else {
      teacherAssignments.forEach(a => {
        const submissions_count = submissions.filter(s => s.assignmentId === a.id).length;
        const div = document.createElement('div');
        div.className = 'assignment-card';
        div.innerHTML = `
          <h4>${a.title}</h4>
          <p>${a.description}</p>
          <p><strong>Subject:</strong> ${a.subject} | <strong>Due:</strong> ${new Date(a.dueDate).toLocaleDateString()}</p>
          <p><strong>Submissions:</strong> ${submissions_count}</p>
          <button onclick="viewSubmissions('${a.id}')" style="width: auto; background: var(--main-blue); color: white;">📋 View Submissions</button>
        `;
        container.appendChild(div);
      });
    }
  } else if(role === "student") {
    const studentAssignments = assignments.filter(a => 
      a.section === currentUserData.section && new Date(a.dueDate) >= new Date()
    );
    
    if(studentAssignments.length === 0) {
      container.innerHTML = "<p>No pending assignments. Great job! 🎉</p>";
    } else {
      studentAssignments.forEach(a => {
        const submission = submissions.find(s => s.assignmentId === a.id && s.student === currentUser);
        let status = 'pending';
        let statusText = '⏳ Pending';
        let grade = '';
        
        if(submission) {
          status = submission.graded ? 'graded' : 'submitted';
          statusText = submission.graded ? '✅ Graded' : '📤 Submitted';
          grade = submission.graded ? `<br><strong>Grade: ${submission.grade}/${a.points}</strong>` : '';
        } else if(new Date(a.dueDate) < new Date()) {
          status = 'late';
          statusText = '⚠️ Late';
        }
        
        const div = document.createElement('div');
        div.className = 'assignment-card';
        div.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: start;">
            <div>
              <h4>${a.title}</h4>
              <p>${a.description}</p>
              <p><strong>Subject:</strong> ${a.subject} | <strong>Due:</strong> ${new Date(a.dueDate).toLocaleDateString()}</p>
              <span class="assignment-status ${status}">${statusText}</span>
              ${grade}
            </div>
            ${!submission ? `
              <button onclick="submitAssignment('${a.id}')" style="width: auto; background: #28a745; color: white;">📤 Submit</button>
            ` : ''}
          </div>
        `;
        container.appendChild(div);
      });
    }
  }
}

function renderQuizzes() {
  const container = document.getElementById('quizzesContainer');
  if(!container) return;
  
  container.innerHTML = '';
  
  const quizzes = window.realtimeQuizzes || [];
  const results = window.realtimeQuizResults || [];
  
  if(role === "teacher") {
    const teacherQuizzes = quizzes.filter(q => q.teacher === currentUser);
    if(teacherQuizzes.length === 0) {
      container.innerHTML = "<p>No quizzes created yet.</p>";
    } else {
      teacherQuizzes.forEach(q => {
        const quizResults = results.filter(r => r.quizId === q.id);
        const avg = quizResults.length ? (quizResults.reduce((a,b) => a + b.score, 0) / quizResults.length).toFixed(2) : 'N/A';
        
        const div = document.createElement('div');
        div.className = 'assignment-card';
        div.innerHTML = `
          <h4>${q.title}</h4>
          <p><strong>Subject:</strong> ${q.subject} | <strong>Questions:</strong> ${q.questions?.length || 0}</p>
          <p><strong>Participants:</strong> ${quizResults.length} | <strong>Average:</strong> ${avg}%</p>
          <button onclick="viewQuizResults('${q.id}')" style="width: auto; background: var(--main-blue); color: white;">📊 Results</button>
        `;
        container.appendChild(div);
      });
    }
  } else if(role === "student") {
    const availableQuizzes = quizzes.filter(q => 
      q.section === currentUserData.section && 
      new Date(q.startTime) <= new Date() && 
      new Date(q.endTime) >= new Date()
    );
    
    if(availableQuizzes.length === 0) {
      container.innerHTML = "<p>No available quizzes at the moment.</p>";
    } else {
      availableQuizzes.forEach(q => {
        const taken = results.find(r => r.quizId === q.id && r.student === currentUser);
        const div = document.createElement('div');
        div.className = 'assignment-card';
        
        if(!taken) {
          div.innerHTML = `
            <h4>${q.title}</h4>
            <p><strong>Subject:</strong> ${q.subject} | <strong>Duration:</strong> ${q.duration} minutes</p>
            <p><strong>Questions:</strong> ${q.questions?.length || 0} | <strong>Ends:</strong> ${new Date(q.endTime).toLocaleString()}</p>
            <button onclick="startQuiz('${q.id}')" style="background: #28a745; color: white;">▶️ Start Quiz</button>
          `;
        } else {
          div.innerHTML = `
            <h4>${q.title} ✅</h4>
            <p><strong>Score:</strong> ${taken.score}% | <strong>Submitted:</strong> ${new Date(taken.submittedAt).toLocaleString()}</p>
          `;
        }
        container.appendChild(div);
      });
    }
  }
}

function renderCourseMaterials() {
  const container = document.getElementById('materialsContainer');
  if(!container) return;
  
  container.innerHTML = '';
  const materials = window.realtimeMaterials || [];
  const subjects = ["3I's","Genchem 2","P6 2","Perdev","CPAR","Entrepreneurship"];
  
  let hasMaterials = false;
  subjects.forEach(sub => {
    const subMaterials = materials.filter(m => m.subject === sub && (m.section === 'all' || m.section === currentUserData.section));
    if(subMaterials.length > 0) {
      hasMaterials = true;
      const header = document.createElement('h4');
      header.textContent = sub;
      container.appendChild(header);
      
      subMaterials.forEach(m => {
        const div = document.createElement('div');
        div.style.cssText = 'padding: 15px; border: 2px solid #dee2e6; border-radius: 10px; margin: 10px 0;';
        div.innerHTML = `
          <h5>${m.title}</h5>
          <p>${m.description}</p>
          <p style="font-size: 12px; color: #666;">Uploaded: ${new Date(m.uploadedAt).toLocaleDateString()}</p>
          <a href="${m.fileUrl}" download style="display: inline-block; padding: 8px 15px; background: var(--main-blue); color: white; border-radius: 5px; text-decoration: none; margin-top: 10px;">⬇️ Download</a>
        `;
        container.appendChild(div);
      });
    }
  });
  
  if(!hasMaterials) {
    container.innerHTML = '<p>No materials uploaded yet.</p>';
  }
}

function renderConferences() {
  const container = document.getElementById('conferencesContainer');
  if(!container) return;
  
  container.innerHTML = '';
  const conferences = window.realtimeConferences || [];
  
  if(role === "teacher") {
    const teacherConferences = conferences.filter(c => c.teacher === currentUser);
    const upcoming = teacherConferences.filter(c => new Date(c.dateTime) >= new Date());
    
    if(upcoming.length > 0) {
      const header = document.createElement('h4');
      header.textContent = 'Upcoming Conferences';
      container.appendChild(header);
      
      upcoming.forEach(c => {
        const div = document.createElement('div');
        div.className = 'conference-slot booked';
        div.innerHTML = `
          <div>
            <strong>${c.parent || 'Unknown'}</strong><br>
            <small>${new Date(c.dateTime).toLocaleString()}</small>
          </div>
          <span style="background: #dc3545; color: white; padding: 5px 15px; border-radius: 20px; font-size: 12px;">Booked</span>
        `;
        container.appendChild(div);
      });
    } else {
      container.innerHTML = '<p>No upcoming conferences.</p>';
    }
  } else if(role === "parent") {
    const availableSlots = conferences.filter(c => c.status === 'available');
    const myConferences = conferences.filter(c => c.parent === currentUser && c.status === 'booked');
    
    if(availableSlots.length > 0) {
      const header = document.createElement('h4');
      header.textContent = 'Available Slots';
      container.appendChild(header);
      
      availableSlots.forEach(c => {
        const div = document.createElement('div');
        div.className = 'conference-slot available';
        div.innerHTML = `
          <div>
            <strong>${c.teacher}</strong><br>
            <small>${new Date(c.dateTime).toLocaleString()}</small>
          </div>
          <button onclick="bookConference('${c.id}')" style="width: auto; background: #28a745; color: white;">Book</button>
        `;
        container.appendChild(div);
      });
    }
    
    if(myConferences.length > 0) {
      const header = document.createElement('h4');
      header.textContent = 'Your Booked Conferences';
      container.appendChild(header);
      
      myConferences.forEach(c => {
        const div = document.createElement('div');
        div.className = 'conference-slot booked';
        div.innerHTML = `
          <div>
            <strong>${c.teacher}</strong><br>
            <small>${new Date(c.dateTime).toLocaleString()}</small>
          </div>
          <button onclick="cancelConference('${c.id}')" style="width: auto; background: #dc3545; color: white;">Cancel</button>
        `;
        container.appendChild(div);
      });
    }
    
    if(availableSlots.length === 0 && myConferences.length === 0) {
      container.innerHTML = '<p>No available slots at the moment. Please check back later.</p>';
    }
  }
}

function renderBehaviorReports() {
  const container = document.getElementById('behaviorContainer');
  if(!container) return;
  
  const logs = window.realtimeBehaviorLog || {};
  
  if(role === "teacher") {
    // Show recent records for all students
    const recentRecords = [];
    Object.entries(logs).forEach(([student, entries]) => {
      entries.forEach(entry => {
        recentRecords.push({...entry, student});
      });
    });
    
    recentRecords.sort((a,b) => new Date(b.date) - new Date(a.date));
    
    if(recentRecords.length > 0) {
      const header = document.createElement('h4');
      header.textContent = 'Recent Records';
      container.appendChild(header);
      
      recentRecords.slice(0, 10).forEach(r => {
        const div = document.createElement('div');
        div.className = `behavior-item ${r.type}`;
        div.innerHTML = `
          <div class="behavior-points">${r.type === 'merit' ? '+' : '-'}${r.points}</div>
          <div style="flex: 1;">
            <strong>${r.student}</strong> - ${r.reason}<br>
            <small>${new Date(r.date).toLocaleDateString()}</small>
          </div>
        `;
        container.appendChild(div);
      });
    }
  } else {
    // Student or parent view
    let targetStudent = currentUser;
    if(role === "parent") {
      targetStudent = currentUserData.childName || currentUser;
    }
    
    const studentLogs = logs[targetStudent] || [];
    const totalPoints = studentLogs.reduce((acc, entry) => {
      return acc + (entry.type === 'merit' ? entry.points : -entry.points);
    }, 0);
    
    const perfBox = document.createElement('div');
    perfBox.className = 'performance-box';
    perfBox.style.background = totalPoints >= 0 ? 'linear-gradient(135deg, #28a745 0%, #20c997 100%)' : 'linear-gradient(135deg, #dc3545 0%, #fd7e14 100%)';
    perfBox.innerHTML = `
      <h3>Behavior Points</h3>
      <div class="stat-number">${totalPoints > 0 ? '+' : ''}${totalPoints}</div>
      <p>${totalPoints >= 20 ? '🏆 Excellent Conduct' : totalPoints >= 0 ? '👍 Good Standing' : '⚠️ Needs Improvement'}</p>
    `;
    container.appendChild(perfBox);
    
    if(studentLogs.length > 0) {
      const header = document.createElement('h4');
      header.textContent = 'Record History';
      container.appendChild(header);
      
      studentLogs.sort((a,b) => new Date(b.date) - new Date(a.date));
      studentLogs.forEach(entry => {
        const div = document.createElement('div');
        div.className = `behavior-item ${entry.type}`;
        div.innerHTML = `
          <div class="behavior-points">${entry.type === 'merit' ? '+' : '-'}${entry.points}</div>
          <div style="flex: 1;">
            <strong>${entry.reason}</strong><br>
            <small>${new Date(entry.date).toLocaleDateString()} by ${entry.teacher}</small>
          </div>
        `;
        container.appendChild(div);
      });
    }
  }
}

function renderHonorRoll() {
  const container = document.getElementById('honorRollContainer');
  if(!container) return;
  
  container.innerHTML = '';
  
  const students = window.realtimeStudents || [];
  const gradesData = window.realtimeGrades || {};
  
  const rankings = students.map(s => {
    const grades = gradesData[s.name] || {};
    const gradeValues = Object.values(grades);
    const avg = gradeValues.length ? (gradeValues.reduce((a,b) => a+b, 0) / gradeValues.length) : 0;
    return {...s, average: avg};
  }).sort((a,b) => b.average - a.average);
  
  const withHighestHonors = rankings.filter(s => s.average >= 98);
  const withHighHonors = rankings.filter(s => s.average >= 95 && s.average < 98);
  const withHonors = rankings.filter(s => s.average >= 90 && s.average < 95);
  
  if(withHighestHonors.length > 0) {
    const div = document.createElement('div');
    div.className = 'honor-roll';
    div.innerHTML = `
      <h4>🥇 With Highest Honors (98-100)</h4>
      <ul class="honor-roll-list">
        ${withHighestHonors.map(s => `
          <li>
            <span>${s.name} - ${s.average.toFixed(2)}%</span>
            <span class="honor-badge">Highest Honors</span>
          </li>
        `).join('')}
      </ul>
    `;
    container.appendChild(div);
  }
  
  if(withHighHonors.length > 0) {
    const div = document.createElement('div');
    div.className = 'honor-roll';
    div.style.cssText = 'background: linear-gradient(135deg, #c0c0c0 0%, #e8e8e8 100%); border-color: #808080;';
    div.innerHTML = `
      <h4 style="color: #555;">🥈 With High Honors (95-97)</h4>
      <ul class="honor-roll-list">
        ${withHighHonors.map(s => `
          <li>
            <span>${s.name} - ${s.average.toFixed(2)}%</span>
            <span class="honor-badge" style="background: #808080;">High Honors</span>
          </li>
        `).join('')}
      </ul>
    `;
    container.appendChild(div);
  }
  
  if(withHonors.length > 0) {
    const div = document.createElement('div');
    div.className = 'honor-roll';
    div.style.cssText = 'background: linear-gradient(135deg, #cd7f32 0%, #daa520 100%); border-color: #8b4513;';
    div.innerHTML = `
      <h4 style="color: #8b4513;">🥉 With Honors (90-94)</h4>
      <ul class="honor-roll-list">
        ${withHonors.map(s => `
          <li>
            <span>${s.name} - ${s.average.toFixed(2)}%</span>
            <span class="honor-badge" style="background: #8b4513;">Honors</span>
          </li>
        `).join('')}
      </ul>
    `;
    container.appendChild(div);
  }
  
  if(role === "student") {
    const myRank = rankings.findIndex(s => s.name === currentUser) + 1;
    const myData = rankings.find(s => s.name === currentUser);
    
    const div = document.createElement('div');
    div.className = 'section';
    div.style.cssText = 'margin-top: 30px; text-align: center;';
    div.innerHTML = `
      <h4>Your Ranking</h4>
      <div style="font-size: 48px; font-weight: bold; color: var(--main-blue);">#${myRank}</div>
      <p>out of ${rankings.length} students</p>
      <p><strong>General Average:</strong> ${myData?.average.toFixed(2)}%</p>
    `;
    container.appendChild(div);
  }
}

function renderPayments() {
  const container = document.getElementById('paymentsContainer');
  if(!container) return;
  
  container.innerHTML = '';
  const payments = window.realtimePayments || [];
  
  let targetUser = currentUser;
  if(role === "parent") {
    targetUser = currentUserData.childName || currentUser;
  }
  
  const myPayments = payments.filter(p => p.student === targetUser);
  const balance = 15000 - myPayments.reduce((a,p) => a + p.amount, 0);
  
  const perfBox = document.createElement('div');
  perfBox.className = 'performance-box';
  perfBox.style.background = balance > 0 ? 'linear-gradient(135deg, #dc3545 0%, #fd7e14 100%)' : 'linear-gradient(135deg, #28a745 0%, #20c997 100%)';
  perfBox.innerHTML = `
    <h3>Outstanding Balance</h3>
    <div class="stat-number">₱${balance.toLocaleString()}</div>
    <p>${balance > 0 ? 'Please settle your balance' : '✅ Fully Paid'}</p>
  `;
  container.appendChild(perfBox);
  
  if(balance > 0 && role !== 'admin') {
    const paymentSection = document.createElement('div');
    paymentSection.innerHTML = `
      <h4>Make Payment</h4>
      <div class="payment-method" onclick="selectPayment(this, 'gcash')">
        <span class="payment-icon">📱</span>
        <div>
          <strong>GCash</strong>
          <p style="margin: 0; font-size: 12px; color: #666;">Pay via GCash e-wallet</p>
        </div>
      </div>
      <div class="payment-method" onclick="selectPayment(this, 'bank')">
        <span class="payment-icon">🏦</span>
        <div>
          <strong>Bank Transfer</strong>
          <p style="margin: 0; font-size: 12px; color: #666;">BDO, BPI, Metrobank</p>
        </div>
      </div>
      <div class="payment-method" onclick="selectPayment(this, 'card')">
        <span class="payment-icon">💳</span>
        <div>
          <strong>Credit/Debit Card</strong>
          <p style="margin: 0; font-size: 12px; color: #666;">Visa, Mastercard</p>
        </div>
      </div>
      <input type="number" id="paymentAmount" placeholder="Amount to pay" max="${balance}">
      <button onclick="processPayment()" style="background: #28a745; color: white; margin-top: 10px;">💳 Pay Now</button>
    `;
    container.appendChild(paymentSection);
  }
  
  if(myPayments.length > 0) {
    const historyHeader = document.createElement('h4');
    historyHeader.textContent = 'Payment History';
    container.appendChild(historyHeader);
    
    myPayments.sort((a,b) => new Date(b.date) - new Date(a.date));
    myPayments.forEach(p => {
      const div = document.createElement('div');
      div.className = 'payment-history-item';
      div.innerHTML = `
        <div>
          <strong>${p.method.toUpperCase()}</strong><br>
          <small>${new Date(p.date).toLocaleDateString()}</small>
        </div>
        <div style="text-align: right;">
          <strong>₱${p.amount.toLocaleString()}</strong><br>
          <span class="payment-status paid">✅ Paid</span>
        </div>
      `;
      container.appendChild(div);
    });
  }
}

function renderScheduleTable(section) {
  const container = document.getElementById('scheduleTable');
  if(!container) return;
  
  // Generate schedule HTML
  let tableHTML = `
    <table>
      <thead>
        <tr>
          <th>Time / Day</th>
          ${WEEKLY_SCHEDULE.days.map(day => `<th>${day}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
  `;
  
  WEEKLY_SCHEDULE.periods.forEach(period => {
    const rowClass = period.type === 'break' ? (period.name === 'Lunch' ? 'lunch' : 'recess') : '';
    tableHTML += `
      <tr class="${rowClass}">
        <td class="time-slot">
          <strong>${period.name}</strong><br>
          <small>${period.time}</small>
        </td>
    `;
    
    if(period.type === 'break') {
      tableHTML += `<td colspan="5" style="text-align: center; font-weight: bold;">${period.name}</td>`;
    } else {
      WEEKLY_SCHEDULE.days.forEach(day => {
        const subject = getSubjectForSlot(section, day, period.name);
        tableHTML += `<td>${subject}</td>`;
      });
    }
    
    tableHTML += '</tr>';
  });
  
  tableHTML += '</tbody></table>';
  container.innerHTML = tableHTML;
}

function getSubjectForSlot(section, day, period) {
  // This would typically come from Firebase
  const subjects = ["3I's","Genchem 2","P6 2","Perdev","CPAR","Entrepreneurship"];
  // Simple hash for demo purposes
  const index = (day.charCodeAt(0) + period.charCodeAt(0)) % subjects.length;
  return subjects[index];
}

function renderAttendanceStats(attendanceData) {
  const container = document.getElementById('attendanceStats');
  if(!container) return;
  
  const dates = Object.keys(attendanceData);
  const presentDays = dates.filter(d => attendanceData[d] === 'P').length;
  const absentDays = dates.filter(d => attendanceData[d] === 'A').length;
  const percentage = dates.length > 0 ? Math.round((presentDays / dates.length) * 100) : 0;
  
  container.innerHTML = `
    <h3>📈 Your Attendance Performance</h3>
    <div class="performance-stats">
      <div class="stat-item"><div class="stat-number">${presentDays}</div><div class="stat-label">✅ Present</div></div>
      <div class="stat-item"><div class="stat-number">${absentDays}</div><div class="stat-label">❌ Absent</div></div>
      <div class="stat-item"><div class="stat-number">${percentage}%</div><div class="stat-label">📊 Rate</div></div>
    </div>
  `;
}

function renderPlanner() {
  const container = document.getElementById('plannerContainer');
  if(!container) return;
  
  container.innerHTML = '';
  const planner = window.realtimePlanner || { daily: [], weekly: [], monthly: [] };
  
  // Daily Goals
  const dailySection = document.createElement('div');
  dailySection.className = 'planner-section';
  dailySection.innerHTML = '<h4>📅 Daily Goals</h4>';
  
  (planner.daily || []).forEach((goal, index) => {
    const item = document.createElement('div');
    item.className = 'planner-item' + (goal.completed ? ' completed' : '');
    item.innerHTML = `
      <input type="checkbox" ${goal.completed ? 'checked' : ''} onchange="togglePlannerGoal('daily', ${index})">
      <span class="goal-text">${goal.text}</span>
      <span class="goal-time">${goal.time || ''}</span>
      <button class="alarm-btn" onclick="setAlarm('${goal.time}')">⏰</button>
      <button onclick="deletePlannerGoal('daily', ${index})" style="width:auto;background:#dc3545;color:white;padding:6px 10px;">×</button>
    `;
    dailySection.appendChild(item);
  });
  
  dailySection.innerHTML += `
    <input type="text" id="dailyGoalInput" placeholder="Add daily goal..." style="width:55%;">
    <input type="time" id="dailyGoalTime" style="width:auto;">
    <button onclick="addPlannerGoal('daily')" style="width:auto;background:#28a745;color:white;">➕ Add</button>
  `;
  container.appendChild(dailySection);
  
  // Weekly Goals
  const weeklySection = document.createElement('div');
  weeklySection.className = 'planner-section';
  weeklySection.innerHTML = '<h4>📆 Weekly Goals</h4>';
  
  (planner.weekly || []).forEach((goal, index) => {
    const item = document.createElement('div');
    item.className = 'planner-item' + (goal.completed ? ' completed' : '');
    item.innerHTML = `
      <input type="checkbox" ${goal.completed ? 'checked' : ''} onchange="togglePlannerGoal('weekly', ${index})">
      <span class="goal-text">${goal.text}</span>
      <span class="goal-time">${goal.time || ''}</span>
      <button onclick="deletePlannerGoal('weekly', ${index})" style="width:auto;background:#dc3545;color:white;padding:6px 10px;">×</button>
    `;
    weeklySection.appendChild(item);
  });
  
  weeklySection.innerHTML += `
    <input type="text" id="weeklyGoalInput" placeholder="Add weekly goal..." style="width:55%;">
    <input type="date" id="weeklyGoalDate" style="width:auto;">
    <button onclick="addPlannerGoal('weekly')" style="width:auto;background:#28a745;color:white;">➕ Add</button>
  `;
  container.appendChild(weeklySection);
  
  // Monthly Goals
  const monthlySection = document.createElement('div');
  monthlySection.className = 'planner-section';
  monthlySection.innerHTML = '<h4>📆 Monthly Goals</h4>';
  
  (planner.monthly || []).forEach((goal, index) => {
    const item = document.createElement('div');
    item.className = 'planner-item' + (goal.completed ? ' completed' : '');
    item.innerHTML = `
      <input type="checkbox" ${goal.completed ? 'checked' : ''} onchange="togglePlannerGoal('monthly', ${index})">
      <span class="goal-text">${goal.text}</span>
      <span class="goal-time">${goal.time || ''}</span>
      <button onclick="deletePlannerGoal('monthly', ${index})" style="width:auto;background:#dc3545;color:white;padding:6px 10px;">×</button>
    `;
    monthlySection.appendChild(item);
  });
  
  monthlySection.innerHTML += `
    <input type="text" id="monthlyGoalInput" placeholder="Add monthly goal..." style="width:55%;">
    <input type="date" id="monthlyGoalDate" style="width:auto;">
    <button onclick="addPlannerGoal('monthly')" style="width:auto;background:#28a745;color:white;">➕ Add</button>
  `;
  container.appendChild(monthlySection);
}

function renderPendingStudents(section, students) {
  // Clear existing content except header
  const header = section.querySelector('h3');
  section.innerHTML = '';
  section.appendChild(header);
  
  if(students.length === 0) {
    section.innerHTML += "<p>✅ No pending approvals.</p>";
  } else {
    students.forEach(function(s){
      const div = document.createElement("div");
      div.style.cssText = 'padding: 15px; border: 2px solid #ddd; margin-bottom: 10px; border-radius: 10px; background: #fff3cd;';
      div.innerHTML = `
        <p><strong>👤 Name:</strong> ${s.name}</p>
        <p><strong>🆔 ID:</strong> ${s.studentId}</p>
        <p><strong>🏫 Section:</strong> ${s.section}</p>
        <button onclick="approveStudent('${s.id}')" style="background: #28a745; color: white; width: auto; padding: 10px 20px; margin-right: 10px;">✅ Approve</button>
        <button onclick="rejectStudent('${s.id}')" style="background: #dc3545; color: white; width: auto; padding: 10px 20px;">🗑️ Reject</button>
      `;
      section.appendChild(div);
    });
  }
}

function renderAllStudents() {
  const container = document.getElementById('studentsContainer');
  if(!container) return;
  
  const students = window.realtimeAllStudents || [];
  const filter = document.getElementById('filterSection')?.value || 'all';
  
  container.innerHTML = '';
  
  let filteredStudents = students;
  if(filter !== "all") {
    filteredStudents = students.filter(s => s.section === filter);
  }
  
  // Update filter options
  const sections = [...new Set(students.map(s => s.section))];
  const filterSelect = document.getElementById('filterSection');
  if(filterSelect && filterSelect.options.length <= 1) {
    sections.forEach(sec => {
      const opt = document.createElement("option");
      opt.value = sec;
      opt.innerText = sec;
      filterSelect.appendChild(opt);
    });
  }
  
  filteredStudents.forEach(function(s){
    const idCard = document.createElement("div");
    idCard.className = "id-card";
    idCard.innerHTML = '<input type="checkbox" class="id-card-checkbox" data-student-id="' + s.id + '">' +
      '<div class="id-card-header"><h3 style="margin:0;">🎓 DUMINGAG SENIOR HIGH SCHOOL</h3><p style="margin:0;font-size:11px;">Student ID Card</p></div>' +
      '<div class="id-card-photo" style="font-size: 36px;">👤</div>' +
      '<div class="id-card-info"><p><strong>Name:</strong> ' + s.name + '</p><p><strong>ID No:</strong> ' + s.studentId + '</p>' +
      '<p><strong>Section:</strong> ' + s.section + '</p><p><strong>Track:</strong> ' + s.track + '</p>' +
      '<p><strong>Strand:</strong> ' + s.strand + '</p><p><strong>Grade:</strong> ' + s.gradeLevel + '</p></div>' +
      '<div class="id-card-footer">🎓 Dumingag Senior High School - Dumingag, Zamboanga del Sur</div>' +
      '<div id="qr-' + s.id + '" style="text-align:center;margin-top:12px;"></div>';
    
    container.appendChild(idCard);
    
    setTimeout(function(){
      try {
        new QRCode(document.getElementById("qr-" + s.id), {
          text: s.name + "-" + s.studentId,
          width: 65,
          height: 65
        });
      } catch(e) {
        console.error('QR generation error:', e);
      }
    }, 100);
  });
}

function renderParentAccounts() {
  const container = document.getElementById('parentContainer');
  if(!container) return;
  
  const accounts = window.realtimeParentAccounts || [];
  const filter = document.getElementById('filterParentSection')?.value || 'all';
  
  container.innerHTML = '';
  
  let filteredAccounts = accounts;
  if(filter !== "all") {
    filteredAccounts = accounts.filter(p => p.section === filter);
  }
  
  // Update filter options
  const sections = [...new Set(accounts.map(p => p.section))];
  const filterSelect = document.getElementById('filterParentSection');
  if(filterSelect && filterSelect.options.length <= 1) {
    sections.forEach(sec => {
      const opt = document.createElement("option");
      opt.value = sec;
      opt.innerText = sec;
      filterSelect.appendChild(opt);
    });
  }
  
  if(filteredAccounts.length === 0) {
    container.innerHTML = "<p>❌ No parent accounts found.</p>";
    return;
  }
  
  filteredAccounts.forEach(function(p){
    const card = document.createElement("div");
    card.className = "parent-account-card";
    card.innerHTML = '<h4>👤 ' + p.studentName + '</h4>' +
      '<p><strong>🆔 Student ID:</strong> ' + p.studentId + '</p>' +
      '<p><strong>🏫 Section:</strong> ' + p.section + '</p>' +
      '<div class="credentials">' +
      '<p><strong>👨‍💼 Parent Email:</strong> ' + p.parentEmail + '</p>' +
      '<p><strong>🔑 Parent Password:</strong> ' + p.parentPassword + '</p>' +
      '</div>';
    container.appendChild(card);
  });
}

function renderManageUsers(allUsers) {
  const container = document.getElementById('manageUsersContainer');
  if(!container) return;
  
  container.innerHTML = '';
  
  const students = allUsers.filter(u => u.role === 'student');
  const teachers = allUsers.filter(u => u.role === 'teacher');
  
  const studentsHeader = document.createElement('h4');
  studentsHeader.textContent = '👨‍🎓 Students';
  container.appendChild(studentsHeader);
  
  const studentsTable = document.createElement("table");
  studentsTable.innerHTML = "<tr><th>Name</th><th>ID</th><th>Section</th><th>Teacher</th><th>Action</th></tr>";
  students.forEach(function(s){
    const tr = document.createElement("tr");
    tr.innerHTML = '<td>' + s.name + '</td><td>' + s.studentId + '</td><td>' + (s.section || '-') + '</td><td>' + (s.teacherName || 'Not Assigned') + '</td>' +
      '<td><button onclick="deleteUser('' + s.id + '')" style="background:#dc3545;color:white;width:auto;padding:6px 12px;">🗑️ Delete</button></td>';
    studentsTable.appendChild(tr);
  });
  container.appendChild(studentsTable);
  
  const teachersHeader = document.createElement('h4');
  teachersHeader.style.marginTop = '25px';
  teachersHeader.textContent = '👨‍🏫 Teachers';
  container.appendChild(teachersHeader);
  
  const teachersTable = document.createElement("table");
  teachersTable.innerHTML = "<tr><th>Name</th><th>ID</th><th>Section</th><th>Action</th></tr>";
  teachers.forEach(function(t){
    const tr = document.createElement("tr");
    tr.innerHTML = '<td>' + t.name + '</td><td>' + (t.teacherId || t.id) + '</td><td>' + (t.sectionHandled || '-') + '</td>' +
      '<td><button onclick="deleteUser('' + t.id + '')" style="background:#dc3545;color:white;width:auto;padding:6px 12px;">🗑️ Delete</button></td>';
    teachersTable.appendChild(tr);
  });
  container.appendChild(teachersTable);
}

function renderAnalytics(data) {
  const container = document.getElementById('analyticsContainer');
  if(!container) return;
  
  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px;">
      <div class="analytics-card">
        <div class="analytics-number">${data.totalStudents || 0}</div>
        <div class="analytics-label">Total Students</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-number">${data.totalTeachers || 0}</div>
        <div class="analytics-label">Teachers</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-number">${data.totalParents || 0}</div>
        <div class="analytics-label">Parents</div>
      </div>
      <div class="analytics-card">
        <div class="analytics-number">${data.pendingApprovals || 0}</div>
        <div class="analytics-label">Pending Approvals</div>
      </div>
    </div>
  `;
  
  if(data.trackDistribution) {
    const trackData = data.trackDistribution;
    const totalStudents = data.totalStudents || 1;
    
    const chartDiv = document.createElement('div');
    chartDiv.className = 'chart-container';
    chartDiv.innerHTML = `
      <h4>Enrollment by Track</h4>
      <div style="margin-top: 20px;">
        ${Object.entries(trackData).map(([track, count]) => `
          <div style="margin: 10px 0;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
              <span>${track}</span>
              <span><strong>${count}</strong> students</span>
            </div>
            <div style="background: #e9ecef; height: 30px; border-radius: 15px; overflow: hidden;">
              <div style="background: linear-gradient(90deg, var(--main-red), var(--main-blue)); height: 100%; width: ${(count/totalStudents*100)}%; display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; font-weight: bold;">
                ${Math.round(count/totalStudents*100)}%
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    container.appendChild(chartDiv);
  }
}

function renderTranscript(grades) {
  const container = document.getElementById('transcriptContainer');
  if(!container) return;
  
  const subjects = ["3I's","Genchem 2","P6 2","Perdev","CPAR","Entrepreneurship"];
  
  container.innerHTML = `
    <div class="transcript-header">
      <h2>DUMINGAG SENIOR HIGH SCHOOL</h2>
      <h3>OFFICIAL TRANSCRIPT OF RECORDS</h3>
      <div class="transcript-seal">OFFICIAL</div>
    </div>
    <div style="margin: 20px 0;">
      <p><strong>Student Name:</strong> ${currentUserData.name}</p>
      <p><strong>Student ID:</strong> ${currentUserData.studentId}</p>
      <p><strong>Track/Strand:</strong> ${currentUserData.track} - ${currentUserData.strand}</p>
      <p><strong>Date of Graduation:</strong> June 2024</p>
    </div>
    <h4>Academic Record</h4>
    <table>
      <tr><th>Subject</th><th>Grade 11</th><th>Grade 12</th><th>Final</th></tr>
      ${subjects.map(sub => {
        const g11Grade = Math.floor(Math.random() * 15) + 85;
        const g12Grade = grades[sub] || 0;
        const final = Math.round((g11Grade + g12Grade) / 2);
        return `
          <tr>
            <td>${sub}</td>
            <td>${g11Grade}</td>
            <td>${g12Grade}</td>
            <td><strong>${final}</strong></td>
          </tr>
        `;
      }).join('')}
    </table>
    <div style="margin-top: 40px; text-align: center;">
      <p><em>This is to certify that the above is a true copy of the academic records of the student.</em></p>
      <div style="margin-top: 60px; display: flex; justify-content: space-around;">
        <div style="text-align: center;">
          <div style="border-top: 1px solid #333; width: 200px; margin: 0 auto; padding-top: 5px;">
            <strong>School Principal</strong><br>
            <small>Signature over Printed Name</small>
          </div>
        </div>
        <div style="text-align: center;">
          <div style="border-top: 1px solid #333; width: 200px; margin: 0 auto; padding-top: 5px;">
            <strong>Registrar</strong><br>
            <small>Signature over Printed Name</small>
          </div>
        </div>
      </div>
      <p style="margin-top: 30px; font-size: 12px; color: #666;">
        Date Issued: ${new Date().toLocaleDateString()}<br>
        Reference No: TR-${currentUserData.studentId}-${Date.now()}
      </p>
    </div>
  `;
}

//====== ATTENDANCE FUNCTIONS ======
async function saveAttendance(student, date, status) {
  try {
    const attendanceRef = window.firebaseFns.doc(db, 'attendance', student);
    const doc = await window.firebaseFns.getDoc(attendanceRef);
    
    let data = {};
    if(doc.exists()) {
      data = doc.data();
    }
    
    data[date] = status;
    data.updatedAt = window.firebaseFns.serverTimestamp();
    
    await window.firebaseFns.setDoc(attendanceRef, data);
  } catch(error) {
    console.error('Error saving attendance:', error);
  }
}

async function loadAttendance(student) {
  try {
    const doc = await window.firebaseFns.getDoc(window.firebaseFns.doc(db, 'attendance', student));
    return doc.exists() ? doc.data() : {};
  } catch(error) {
    console.error('Error loading attendance:', error);
    return {};
  }
}

//====== HELPER FUNCTIONS ======
function getSubjectForSlot(section, day, period) {
  const subjects = ["3I's","Genchem 2","P6 2","Perdev","CPAR","Entrepreneurship"];
  const index = (day.charCodeAt(0) + period.charCodeAt(0)) % subjects.length;
  return subjects[index];
}

//====== PHOTO UPLOAD FUNCTIONS ======
function triggerPhotoUpload() {
  const el = document.getElementById('photoUpload');
  if (el) el.click();
}

async function handlePhotoUpload(event) {
  const file = event.target.files[0];
  if(!file) return;
  
  if(!file.type.startsWith('image/')) {
    alert('Please select an image file');
    return;
  }
  
  if(file.size > 5 * 1024 * 1024) {
    alert('File size must be less than 5MB');
    return;
  }
  
  try {
    document.getElementById('loadingOverlay').style.display = 'flex';
    document.getElementById('loadingOverlay').classList.remove('hidden');
    document.getElementById('loadingStatus').textContent = 'Uploading photo...';
    
    const storageRef = window.firebaseFns.ref(storage, `profilePhotos/${currentUserId}`);
    await window.firebaseFns.uploadBytes(storageRef, file);
    const downloadURL = await window.firebaseFns.getDownloadURL(storageRef);
    
    await window.firebaseFns.setDoc(
      window.firebaseFns.doc(db, 'users', currentUserId),
      { photoURL: downloadURL },
      { merge: true }
    );
    
    currentUserData.photoURL = downloadURL;
    
    const photoDiv = document.getElementById('profilePhoto');
    if (photoDiv) {
      photoDiv.innerHTML = `<img src="${downloadURL}" style="width: 100%; height: 100%; object-fit: cover;" />`;
      photoDiv.style.background = 'transparent';
    }
    
    hideLoadingOverlay();
    alert('✅ Photo uploaded successfully!');
    
  } catch(error) {
    hideLoadingOverlay();
    console.error('Error uploading photo:', error);
    alert('❌ Failed to upload photo. Please try again.');
  }
}

//====== ADDITIONAL FUNCTIONS ======
async function updateGradeFirebase(student, subject, newGrade) {
  const grade = parseInt(newGrade);
  if(isNaN(grade) || grade < 0 || grade > 100) {
    alert("⚠️ Grade must be between 0 and 100.");
    loadSection("Grades");
    return;
  }
  
  try {
    const gradeRef = window.firebaseFns.doc(db, 'grades', student);
    const doc = await window.firebaseFns.getDoc(gradeRef);
    
    let data = {};
    if(doc.exists()) {
      data = doc.data();
    }
    
    data[subject] = grade;
    data.updatedAt = window.firebaseFns.serverTimestamp();
    data.updatedBy = currentUser;
    
    await window.firebaseFns.setDoc(gradeRef, data);
    
    // Update grade history
    const historyRef = window.firebaseFns.doc(db, 'gradeHistory', student);
    const historyDoc = await window.firebaseFns.getDoc(historyRef);
    let historyData = {};
    if(historyDoc.exists()) {
      historyData = historyDoc.data();
    }
    if(!historyData[subject]) historyData[subject] = [];
    historyData[subject].push({
      quarter: 1,
      grade: grade,
      date: new Date().toISOString(),
      updatedBy: currentUser
    });
    await window.firebaseFns.setDoc(historyRef, historyData);
    
    addNotification(`Your grade in ${subject} has been updated to ${grade}`, 'grade', student);
  } catch(error) {
    console.error('Error updating grade:', error);
    alert('❌ Failed to update grade');
  }
}

function toggleGradeHistory(){
  const studentSelect = document.getElementById('gradesStudentSelect');
  const studentName = studentSelect ? studentSelect.value : currentUser;
  renderGradesTable(document.querySelector('.section'), studentName);
}

function toggleSelectAllStudents() {
  const selectAll = document.getElementById("selectAllStudents");
  const checkboxes = document.querySelectorAll(".id-card-checkbox");
  checkboxes.forEach(function(cb){
    cb.checked = selectAll.checked;
  });
}

function printSelectedIDs() {
  const checkboxes = document.querySelectorAll(".id-card-checkbox:checked");
  if(checkboxes.length === 0) {
    alert("⚠️ Please select at least one student to print!");
    return;
  }
  window.print();
}

async function approveStudent(studentId) {
  await setDocument('users', studentId, { approved: true });
  
  // Sync student with teacher after approval
  const studentDoc = await window.firebaseFns.getDoc(window.firebaseFns.doc(db, 'users', studentId));
  if(studentDoc.exists()) {
    const studentData = studentDoc.data();
    // Temporary swap to sync
    const originalUserData = currentUserData;
    const originalUserId = currentUserId;
    currentUserData = studentData;
    currentUserId = studentId;
    await syncStudentWithTeacher();
    currentUserData = originalUserData;
    currentUserId = originalUserId;
  }
  
  // Update analytics
  await updateAnalytics();
  
  addNotification('Your account has been approved!', 'approval', studentId);
  alert("✅ Student approved and synced with teacher!");
}

async function rejectStudent(studentId) {
  if(confirm("⚠️ Are you sure you want to reject this student?")) {
    await window.firebaseFns.deleteDoc(window.firebaseFns.doc(db, 'users', studentId));
    
    // Update analytics
    await updateAnalytics();
    
    alert("🗑️ Student rejected");
  }
}

async function deleteUser(userId) {
  if(confirm("⚠️ Are you sure you want to delete this user?")) {
    await window.firebaseFns.deleteDoc(window.firebaseFns.doc(db, 'users', userId));
    
    // Update analytics
    await updateAnalytics();
    
    alert("🗑️ User deleted");
  }
}

async function createTeacher() {
  const name = document.getElementById("newTeacherName").value.trim();
  const id = document.getElementById("newTeacherID").value.trim();
  const position = document.getElementById("newTeacherPosition").value.trim();
  const section = document.getElementById("newTeacherSection").value.trim();
  const username = document.getElementById("newTeacherUsername").value.trim();
  const email = document.getElementById("newTeacherEmail").value.trim();
  const password = document.getElementById("newTeacherPassword").value.trim();
  
  if(!name || !username || !password || !section || !email) {
    alert("⚠️ Please fill in all required fields!");
    return;
  }
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if(!emailRegex.test(email)) {
    alert("Please enter a valid email address");
    return;
  }
  
  if(password.length < 8) {
    alert("Password must be at least 8 characters");
    return;
  }
  
  try {
    document.getElementById('loadingOverlay').style.display = 'flex';
    document.getElementById('loadingOverlay').classList.remove('hidden');
    document.getElementById('loadingStatus').textContent = 'Creating teacher account...';

    // USE SECONDARY APP TO PREVENT ADMIN LOGOUT
    const secondaryApp = window.firebaseFns.initializeApp(window.firebaseApp.options, "TeacherCreationApp");
    const secondaryAuth = window.firebaseFns.getAuth(secondaryApp);
    
    const userCredential = await window.firebaseFns.createUserWithEmailAndPassword(secondaryAuth, email, password);
    const teacherUid = userCredential.user.uid;
    
    // Clean up secondary app
    await window.firebaseFns.deleteApp(secondaryApp);

    await window.firebaseFns.setDoc(window.firebaseFns.doc(db, 'users', teacherUid), {
      uid: teacherUid,
      name: name,
      teacherId: id,
      position: position,
      sectionHandled: section,
      username: username,
      email: email,
      role: 'teacher',
      approved: true,
      createdAt: window.firebaseFns.serverTimestamp()
    });
    
    // Sync students already in this section to the new teacher
    await syncStudentsToNewTeacher(section, teacherUid, name);
    
    // Update analytics after creating teacher
    await updateAnalytics();
    
    alert("✅ Teacher account created successfully! Students in section " + section + " have been automatically linked.");
    
    // Clear inputs
    ["newTeacherName", "newTeacherID", "newTeacherPosition", "newTeacherSection", "newTeacherUsername", "newTeacherEmail", "newTeacherPassword"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    
    hideLoadingOverlay();
  } catch(error) {
    hideLoadingOverlay();
    alert("❌ " + error.message);
  }
}

async function syncStudentsToNewTeacher(section, teacherId, teacherName) {
  try {
    const studentsQuery = window.firebaseFns.query(
      window.firebaseFns.collection(db, 'users'),
      window.firebaseFns.where('role', '==', 'student'),
      window.firebaseFns.where('section', '==', section),
      window.firebaseFns.where('approved', '==', true)
    );
    
    const studentsSnapshot = await window.firebaseFns.getDocs(studentsQuery);
    
    if(!studentsSnapshot.empty) {
      const students = [];
      const batch = window.firebaseFns.writeBatch(db);
      
      studentsSnapshot.docs.forEach(doc => {
        const studentData = doc.data();
        students.push({
          id: doc.id,
          name: studentData.name,
          studentId: studentData.studentId,
          section: studentData.section,
          gradeLevel: studentData.gradeLevel,
          addedAt: new Date().toISOString()
        });
        
        const studentRef = window.firebaseFns.doc(db, 'users', doc.id);
        batch.update(studentRef, {
          teacherId: teacherId,
          teacherName: teacherName,
          syncedAt: window.firebaseFns.serverTimestamp()
        });
      });
      
      const teacherStudentsRef = window.firebaseFns.doc(db, 'teacherStudents', teacherId);
      batch.set(teacherStudentsRef, { students });
      
      await batch.commit();
    }
  } catch(error) {
    console.error('Error syncing students to new teacher:', error);
  }
}

// Expose functions to window
window.login = login;
window.submitSignup = submitSignup;
window.sendRecoveryEmail = sendRecoveryEmail;
window.logout = logout;
window.toggleMenu = toggleMenu;
window.togglePassword = togglePassword;
window.showSignup = showSignup;
window.showLogin = showLogin;
window.showForgotPassword = showForgotPassword;
window.clearSignup = clearSignup;
window.checkPasswordStrength = checkPasswordStrength;
window.loadSection = loadSection;
window.selectSemester = selectSemester;
window.selectQuarter = selectQuarter;
window.toggleGradeHistory = toggleGradeHistory;
window.updateGradeFirebase = updateGradeFirebase;
window.triggerPhotoUpload = triggerPhotoUpload;
window.handlePhotoUpload = handlePhotoUpload;
window.approveStudent = approveStudent;
window.rejectStudent = rejectStudent;
window.deleteUser = deleteUser;
window.createTeacher = createTeacher;
window.toggleSelectAllStudents = toggleSelectAllStudents;
window.printSelectedIDs = printSelectedIDs;
window.showCreateAssignment = showCreateAssignment;
window.createAssignment = createAssignment;
window.viewSubmissions = viewSubmissions;
window.gradeSubmission = gradeSubmission;
window.submitAssignment = submitAssignment;
window.showCreateQuiz = showCreateQuiz;
window.addQuestion = addQuestion;
window.saveQuiz = saveQuiz;
window.startQuiz = startQuiz;
window.selectOption = selectOption;
window.submitQuiz = submitQuiz;
window.generateSlots = generateSlots;
window.bookConference = bookConference;
window.cancelConference = cancelConference;
window.addBehaviorRecord = addBehaviorRecord;
window.selectPayment = selectPayment;
window.processPayment = processPayment;
window.nextEnrollStep = nextEnrollStep;
window.prevEnrollStep = prevEnrollStep;
window.submitEnrollment = submitEnrollment;
window.toggleNotifications = toggleNotifications;
window.toggleDarkMode = toggleDarkMode;
window.changeLanguage = changeLanguage;
window.installPWA = installPWA;
window.selectMood = selectMood;
window.sendMoodMessage = sendMoodMessage;
window.addPlannerGoal = addPlannerGoal;
window.togglePlannerGoal = togglePlannerGoal;
window.deletePlannerGoal = deletePlannerGoal;
window.setAlarm = setAlarm;
window.updateSubject = updateSubject;
window.updateScheduleTime = updateScheduleTime;
window.deleteSubject = deleteSubject;
window.addSubject = addSubject;