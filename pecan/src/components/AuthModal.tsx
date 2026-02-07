import { useState, useEffect } from 'react';
import { auth, googleProvider, isFirebaseConfigured } from '../lib/firebase';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { Button } from './Button';

interface AuthModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
    const [user, setUser] = useState<User | null>(null);

    useEffect(() => {
        // Skip if Firebase is not configured
        if (!auth) return;

        const unsubscribe = onAuthStateChanged(auth, (user) => {
            setUser(user);
        });

        return () => unsubscribe();
    }, []);

    const handleGoogleSignIn = async () => {
        if (!auth || !googleProvider) return;

        setLoading(true);
        setMessage(null);
        try {
            await signInWithPopup(auth, googleProvider);
            setMessage({ type: 'success', text: 'Signed in successfully!' });
        } catch (error: any) {
            // Handle popup closed by user
            if (error.code === 'auth/popup-closed-by-user') {
                setMessage(null);
            } else {
                setMessage({ type: 'error', text: error.message || 'Sign in failed' });
            }
        }
        setLoading(false);
    };

    const handleSignOut = async () => {
        if (!auth) return;
        await signOut(auth);
        onClose();
    };

    if (!isOpen) return null;

    // Show message if Firebase is not configured
    if (!isFirebaseConfigured) {
        return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
                <div className="bg-sidebar rounded-xl border border-gray-600 w-[90%] max-w-md p-6 relative animate-in fade-in zoom-in-95 duration-200">
                    <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white">✕</button>
                    <h2 className="text-2xl font-semibold text-white mb-6">Cloud Sync</h2>
                    <p className="text-gray-400">Cloud sync is not available in this environment.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="bg-sidebar rounded-xl border border-gray-600 w-[90%] max-w-md p-6 relative animate-in fade-in zoom-in-95 duration-200">
                <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white">✕</button>

                <h2 className="text-2xl font-semibold text-white mb-6">Cloud Sync Login</h2>

                {user ? (
                    <div className="text-center space-y-4">
                        <div className="flex items-center justify-center gap-3 mb-2">
                            {user.photoURL && (
                                <img src={user.photoURL} alt="Profile" className="w-10 h-10 rounded-full" />
                            )}
                            <div className="text-left">
                                <p className="text-green-400">{user.displayName || user.email}</p>
                                {user.displayName && <p className="text-gray-400 text-sm">{user.email}</p>}
                            </div>
                        </div>
                        <p className="text-gray-400 text-sm">Your dashboard config will sync automatically.</p>
                        <Button onClick={handleSignOut} variant="danger" className="w-full">Sign Out</Button>
                    </div>
                ) : (
                    <div className="space-y-6">
                        <Button
                            onClick={handleGoogleSignIn}
                            variant="primary"
                            className="w-full flex items-center justify-center gap-2"
                            disabled={loading}
                        >
                            <svg className="w-5 h-5" viewBox="0 0 24 24">
                                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                                <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                            </svg>
                            {loading ? 'Signing in...' : 'Sign in with Google'}
                        </Button>

                        {message && (
                            <div className={`p-3 rounded text-sm ${message.type === 'success' ? 'bg-green-900/50 text-green-200' : 'bg-red-900/50 text-red-200'}`}>
                                {message.text}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
