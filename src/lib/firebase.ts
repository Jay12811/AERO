import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, getDoc, onSnapshot, query, where, orderBy, addDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import firebaseConfigPlaceholder from '../../firebase-applet-config.json';

const getFirebaseConfig = () => {
  const envConfig = (import.meta as any).env?.VITE_FIREBASE_CONFIG;
  if (envConfig) {
    try {
      const parsed = JSON.parse(envConfig);
      console.log(`AERO // Neural link established with remote project: ${parsed.projectId}`);
      return parsed;
    } catch (e) {
      console.error("AERO // Remote configuration corrupted. Fallback required.", e);
    }
  }

  // Fallback to individual environment variables
  const individualConfig: any = {
    apiKey: (import.meta as any).env?.VITE_FIREBASE_API_KEY,
    authDomain: (import.meta as any).env?.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: (import.meta as any).env?.VITE_FIREBASE_PROJECT_ID,
    storageBucket: (import.meta as any).env?.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: (import.meta as any).env?.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: (import.meta as any).env?.VITE_FIREBASE_APP_ID,
    firestoreDatabaseId: (import.meta as any).env?.VITE_FIREBASE_FIRESTORE_DATABASE_ID
  };

  // Check if we have at least the core identity variables
  if (individualConfig.apiKey && individualConfig.projectId) {
    console.log(`AERO // Remote identity detected: ${individualConfig.projectId}`);
    return individualConfig;
  }

  if (firebaseConfigPlaceholder.apiKey && firebaseConfigPlaceholder.apiKey !== "YOUR_API_KEY") {
    console.log("AERO // Using local node defaults (Internal Build).");
    return firebaseConfigPlaceholder;
  }

  console.warn("AERO // CRITICAL: No valid Firebase configuration found. Identity Link will fail.");
  return individualConfig; // Return the empty config so app doesn't crash but login will show error
};

const firebaseConfig = getFirebaseConfig();

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Use specifically named database if present, otherwise default to '(default)'
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId || '(default)');
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export const signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;
    
    // Create or update user profile
    await setDoc(doc(db, 'users', user.uid), {
      userId: user.uid,
      email: user.email,
      displayName: user.displayName,
      createdAt: serverTimestamp()
    }, { merge: true });
    
    return user;
  } catch (error) {
    console.error("Auth Error:", error);
    throw error;
  }
};

export const logout = () => signOut(auth);
