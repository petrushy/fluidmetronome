const CDN_BASE = "https://www.gstatic.com/firebasejs/12.7.0";

// Firebase SDK functions — populated by loadSDK() the first time Firebase is
// needed. Undefined until then, so we can detect offline/unconfigured state.
let initializeApp;
let getAuth, getRedirectResult, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut;
let collection, deleteDoc, doc, getDocs, getFirestore, orderBy, query, serverTimestamp, setDoc;
let getDownloadURL, getStorage, ref, uploadBytes;

let sdkAvailable = false;

// Load the Firebase SDK from the CDN. Returns true on success, false if
// the network is unavailable or the CDN can't be reached (e.g. offline).
async function loadSDK() {
  try {
    ({ initializeApp } = await import(`${CDN_BASE}/firebase-app.js`));
    ({
      getAuth,
      getRedirectResult,
      GoogleAuthProvider,
      onAuthStateChanged,
      signInWithPopup,
      signInWithRedirect,
      signOut,
    } = await import(`${CDN_BASE}/firebase-auth.js`));
    ({
      collection,
      deleteDoc,
      doc,
      getDocs,
      getFirestore,
      orderBy,
      query,
      serverTimestamp,
      setDoc,
    } = await import(`${CDN_BASE}/firebase-firestore.js`));
    ({ getDownloadURL, getStorage, ref, uploadBytes } = await import(
      `${CDN_BASE}/firebase-storage.js`
    ));
    sdkAvailable = true;
  } catch {
    sdkAvailable = false;
  }
}

const firebaseConfig = window.fluidMetronomeFirebaseConfig || {};
const hasRequiredConfig = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.storageBucket &&
    firebaseConfig.appId,
);

let app = null;
let auth = null;
let db = null;
let storage = null;
let initPromise = null;
let currentUser = null;

function authStatus() {
  return {
    configured: sdkAvailable && hasRequiredConfig,
    authenticated: Boolean(currentUser),
    user_display_name: currentUser?.displayName ?? null,
    user_email: currentUser?.email ?? null,
    uid: currentUser?.uid ?? null,
  };
}

function requireConfigured() {
  if (!sdkAvailable) {
    throw new Error("Firebase SDK is unavailable (offline or network error).");
  }
  if (!hasRequiredConfig) {
    throw new Error("Firebase is not configured yet. Add your keys in /static/firebase-config.js.");
  }
}

function requireSignedIn() {
  requireConfigured();
  if (!currentUser) {
    throw new Error("Sign in with Google to use cloud storage.");
  }
}

function isTouchDevice() {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

async function initFirebase() {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    // Load the SDK first; if we're offline this resolves with sdkAvailable=false.
    await loadSDK();

    if (!sdkAvailable || !hasRequiredConfig) {
      return authStatus();
    }

    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    storage = getStorage(app);

    // Wait for the first auth state event (fires quickly from cached credentials,
    // no network round-trip needed).
    await new Promise((resolve) => {
      const unsubscribe = onAuthStateChanged(auth, (user) => {
        currentUser = user;
        unsubscribe();
        resolve();
      });
    });

    // Only call getRedirectResult when we're actually returning from a redirect
    // sign-in flow. Without this guard it makes a network request on every page load.
    if (sessionStorage.getItem("fluidMetronomeAwaitingRedirect")) {
      sessionStorage.removeItem("fluidMetronomeAwaitingRedirect");
      try {
        const redirectResult = await getRedirectResult(auth);
        if (redirectResult?.user) {
          currentUser = redirectResult.user;
        }
      } catch (error) {
        console.error("Firebase redirect handling failed", error);
      }
    }

    return authStatus();
  })();

  return initPromise;
}

async function ensureFirebase() {
  await initFirebase();
  return authStatus();
}

window.fluidMetronomeFirebaseGetStatus = async function () {
  return ensureFirebase();
};

window.fluidMetronomeFirebaseSignIn = async function () {
  await ensureFirebase();
  requireConfigured();

  const provider = new GoogleAuthProvider();

  if (isTouchDevice()) {
    sessionStorage.setItem("fluidMetronomeAwaitingRedirect", "1");
    await signInWithRedirect(auth, provider);
    return authStatus();
  }

  const result = await signInWithPopup(auth, provider);
  currentUser = result.user;
  return authStatus();
};

window.fluidMetronomeFirebaseSignOut = async function () {
  await ensureFirebase();
  requireConfigured();
  await signOut(auth);
  currentUser = null;
  return authStatus();
};

window.fluidMetronomeFirebaseListPatterns = async function () {
  await ensureFirebase();
  requireSignedIn();

  const patternsRef = collection(db, "users", currentUser.uid, "patterns");
  const snapshot = await getDocs(query(patternsRef, orderBy("updatedAt", "desc")));

  return snapshot.docs.map((entry) => {
    const data = entry.data();
    return {
      id: entry.id,
      title: data.title || "Untitled pattern",
      pattern: data.pattern,
      updated_at: data.updatedAt?.toDate?.()?.toISOString?.() || "",
    };
  });
};

window.fluidMetronomeFirebaseSavePattern = async function (patternId, patternJson) {
  await ensureFirebase();
  requireSignedIn();

  const pattern = JSON.parse(patternJson);
  const patternsRef = collection(db, "users", currentUser.uid, "patterns");
  const patternRef = patternId ? doc(patternsRef, patternId) : doc(patternsRef);

  await setDoc(patternRef, {
    title: pattern.title || "Untitled pattern",
    pattern,
    updatedAt: serverTimestamp(),
  });

  return patternRef.id;
};

window.fluidMetronomeFirebaseDeletePattern = async function (patternId) {
  await ensureFirebase();
  requireSignedIn();
  await deleteDoc(doc(db, "users", currentUser.uid, "patterns", patternId));
  return true;
};

window.fluidMetronomeFirebaseUploadSample = async function (file) {
  await ensureFirebase();
  requireSignedIn();

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const storagePath = `users/${currentUser.uid}/samples/${Date.now()}-${safeName}`;
  const storageRef = ref(storage, storagePath);

  await uploadBytes(storageRef, file, {
    contentType: file.type || undefined,
  });

  const downloadUrl = await getDownloadURL(storageRef);

  return {
    name: file.name,
    download_url: downloadUrl,
    storage_path: storagePath,
  };
};

initFirebase().catch((error) => {
  console.error("Firebase initialization failed", error);
});
