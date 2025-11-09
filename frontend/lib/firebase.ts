// lib/firebase.ts
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "firebase/auth";
import { signOut } from "firebase/auth";

// Load Firebase configuration from NEXT_PUBLIC_* environment variables.
// These variables must be set in your environment (e.g. frontend/.env) for the client to initialize Firebase.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

export const auth = getAuth(app);

// Automatically log in anonymously (browser only)
if (typeof window !== "undefined") {
  signInAnonymously(auth).catch(console.error);
}

// hook for UID
export function onAuthReady(callback: (uid: string) => void) {
  onAuthStateChanged(auth, (user) => {
    if (user) callback(user.uid);
  });
}

// Create a fresh anonymous auth session. This signs out the current user (if any)
// and signs in anonymously again, resolving with the new UID once available.
export async function createNewAnonymousSession(): Promise<string> {
  try {
    await signOut(auth).catch(() => {});
  } catch (e) {
    // ignore
  }
  await signInAnonymously(auth);
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        resolve(user.uid);
        unsub();
      }
    });
  });
}
