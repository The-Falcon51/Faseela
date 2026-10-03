import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  getIdTokenResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAbjN1BZ0CvPlbC5C66xHIMWvayIKhgyN4',
  authDomain: 'gen-lang-client-0319369264.firebaseapp.com',
  projectId: 'gen-lang-client-0319369264',
  storageBucket: 'gen-lang-client-0319369264.firebasestorage.app',
  messagingSenderId: '745360663466',
  appId: '1:745360663466:web:a9b71332bb78685e5a01d3',
  measurementId: 'G-MFYVXCCKP9'
};

const databaseId = 'faseela-prod';
const functionsRegion = 'europe-west3';
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, databaseId);
const functions = getFunctions(app, functionsRegion);
const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);

if (isLocalhost) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}

const roleNames = {
  investor: { ar: 'مستثمر زراعي', en: 'Agricultural Investor' },
  farmer: { ar: 'مزارع شريك', en: 'Partner Farmer' },
  mill_operator: { ar: 'صاحب معصرة', en: 'Mill Operator' },
  finance_admin: { ar: 'مدقق مالي', en: 'Finance Administrator' },
  quality_auditor: { ar: 'مدقق جودة', en: 'Quality Auditor' },
  admin: { ar: 'إدارة المنصة', en: 'Platform Administrator' }
};

function dispatchAuthState(detail) {
  window.dispatchEvent(new CustomEvent('faseela-auth-state', { detail }));
}

async function ensurePrivateProfile(user, profileData = {}) {
  const profileRef = doc(db, 'users_private', user.uid);
  const existing = await getDoc(profileRef);
  if (existing.exists()) return existing.data();

  const profile = {
    uid: user.uid,
    email: user.email || '',
    displayName: profileData.displayName || user.displayName || '',
    phone: profileData.phone || '',
    region: profileData.region || '',
    requestedRole: profileData.requestedRole || 'investor',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  await setDoc(profileRef, profile);
  return profile;
}

async function createPendingRoleApplication(user, profile) {
  const role = profile?.requestedRole;
  if (!user.emailVerified || !['farmer', 'mill_operator'].includes(role)) return;

  const applicationRef = doc(db, 'role_applications', user.uid);
  const existing = await getDoc(applicationRef);
  if (existing.exists()) return;

  await setDoc(applicationRef, {
    userId: user.uid,
    requestedRole: role,
    region: profile.region || '',
    organizationName: '',
    message: '',
    status: 'pending',
    submittedAt: serverTimestamp()
  });
}

async function publishSession(user) {
  if (!user) {
    dispatchAuthState(null);
    return;
  }

  let profile = {};
  try {
    profile = await ensurePrivateProfile(user);
    await createPendingRoleApplication(user, profile);
  } catch (error) {
    console.warn('Firebase profile data is not available yet:', error.code || error.message);
  }

  let claims = {};
  try {
    claims = (await getIdTokenResult(user)).claims;
  } catch (error) {
    console.warn('Could not read Firebase role claims:', error.code || error.message);
  }

  const claimRole = claims.admin === true ? 'admin' : claims.role || 'investor';
  const appRole = claimRole === 'mill_operator' ? 'mill_owner' : claimRole;
  const labels = roleNames[claimRole] || roleNames.investor;
  const displayName = profile.displayName || user.displayName || user.email?.split('@')[0] || 'Investor';
  const avatar = displayName.trim().charAt(0) || '؟';

  dispatchAuthState({
    id: user.uid,
    uid: user.uid,
    email: user.email || '',
    phone: profile.phone || user.phoneNumber || '',
    name: displayName,
    name_en: displayName,
    role: appRole,
    roleName: labels.ar,
    roleName_en: labels.en,
    avatar,
    avatar_en: avatar,
    badgeColor: claimRole === 'admin' ? 'bg-purple-100 text-purple-950' : 'bg-olive-100 text-olive-800',
    region: profile.region || '',
    email_verified: user.emailVerified,
    auth_provider: user.providerData?.[0]?.providerId || 'password',
    permittedPages: ['home', 'marketplace', 'dashboard']
  });
}

onAuthStateChanged(auth, (user) => {
  publishSession(user).catch((error) => {
    console.error('Could not initialize the Faseela session:', error);
    dispatchAuthState(null);
  });
});

async function signIn(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
  if (!credential.user.emailVerified) {
    await sendEmailVerification(credential.user);
    await signOut(auth);
    const error = new Error('Verify your email using the link we just sent, then sign in again.');
    error.code = 'auth/email-not-verified';
    throw error;
  }
  await publishSession(credential.user);
  return credential.user;
}

async function register({ email, password, displayName, phone, requestedRole, region }) {
  const credential = await createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
  const user = credential.user;
  await updateProfile(user, { displayName: displayName.trim() });

  const profile = {
    uid: user.uid,
    email: user.email || email.trim().toLowerCase(),
    displayName: displayName.trim(),
    phone: phone.trim(),
    region: region.trim(),
    requestedRole: ['farmer', 'mill_operator'].includes(requestedRole) ? requestedRole : 'investor',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  try {
    await setDoc(doc(db, 'users_private', user.uid), profile);
  } catch (error) {
    console.warn('Account created; private profile setup will retry after Firestore is enabled:', error.code || error.message);
  }

  await sendEmailVerification(user);
  await signOut(auth);
  return { email: user.email, requestedRole: profile.requestedRole };
}

async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const credential = await signInWithPopup(auth, provider);
  await ensurePrivateProfile(credential.user);
  await publishSession(credential.user);
  return credential.user;
}

async function requestPasswordReset(email) {
  if (!email || !email.includes('@')) {
    const error = new Error('Enter the email address for your account first.');
    error.code = 'auth/invalid-email';
    throw error;
  }
  await sendPasswordResetEmail(auth, email.trim().toLowerCase());
}

const callable = (name) => httpsCallable(functions, name);

window.FaseelaFirebase = {
  auth,
  signIn,
  register,
  signInWithGoogle,
  signOut: () => signOut(auth),
  requestPasswordReset,
  createInvestmentRequest: (data) => callable('createInvestmentRequest')(data),
  submitInvestmentPaymentProof: (data) => callable('submitInvestmentPaymentProof')(data),
  reviewInvestmentRequest: (data) => callable('reviewInvestmentRequest')(data),
  submitFarmerUpdate: (data) => callable('submitFarmerUpdate')(data),
  reviewFarmerUpdate: (data) => callable('reviewFarmerUpdate')(data),
  submitPressingBatch: (data) => callable('submitPressingBatch')(data),
  certifyPressingBatch: (data) => callable('certifyPressingBatch')(data)
};