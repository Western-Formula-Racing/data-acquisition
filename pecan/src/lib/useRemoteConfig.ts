import { useEffect, useState, useCallback } from 'react';
import { auth, db, type UserConfig } from '../lib/firebase';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { doc, setDoc, getDoc } from 'firebase/firestore';

// Debounce helper
function debounce<T extends (...args: any[]) => void>(func: T, wait: number): T {
    let timeout: any;
    return ((...args: any[]) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    }) as T;
}

export function useRemoteConfig() {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        // Skip if Firebase is not configured
        if (!auth) return;

        const unsubscribe = onAuthStateChanged(auth, (user) => {
            setUser(user);
        });

        return () => unsubscribe();
    }, []);

    const saveConfig = useCallback(
        debounce(async (config: UserConfig['config_data']) => {
            if (!db || !user) return;

            console.log('[Sync] Saving config to cloud...', config);

            try {
                await setDoc(doc(db, 'user_configs', user.uid), {
                    user_id: user.uid,
                    config_data: config,
                    updated_at: new Date().toISOString(),
                });
                console.log('[Sync] Config saved successfully.');
            } catch (error) {
                console.error('[Sync] Error saving config:', error);
            }
        }, 2000),
        [user]
    );

    const loadConfig = async (): Promise<UserConfig['config_data'] | null> => {
        if (!db || !user) return null;
        setLoading(true);

        try {
            const docRef = doc(db, 'user_configs', user.uid);
            const docSnap = await getDoc(docRef);

            setLoading(false);

            if (docSnap.exists()) {
                console.log('[Sync] Config loaded from cloud.');
                return docSnap.data().config_data;
            }
            return null;
        } catch (error) {
            console.error('[Sync] Error loading config:', error);
            setLoading(false);
            return null;
        }
    };

    return {
        user,
        session: user ? { user: { id: user.uid, email: user.email } } : null, // Compatibility shim
        saveConfig,
        loadConfig,
        loading
    };
}
