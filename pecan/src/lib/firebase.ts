import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Check if Firebase is configured (graceful degradation for Docker/CI environments)
const isConfigured = firebaseConfig.apiKey && firebaseConfig.projectId;

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let googleProvider: GoogleAuthProvider | null = null;

if (isConfigured) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    googleProvider = new GoogleAuthProvider();
}

export { app, auth, db, googleProvider };
export const isFirebaseConfigured = isConfigured;

// Types for our config collection
export interface MonitorPreset {
    name: string;
    nodes: any[];
    edges: any[];
}

export interface UserConfig {
    id?: string;
    user_id: string;
    config_data: {
        plots?: any[];
        viewMode?: string;
        sortingMethod?: string;
        monitorPresets?: MonitorPreset[];
        activeMonitorPreset?: string | null;
    };
    updated_at: string;
}
