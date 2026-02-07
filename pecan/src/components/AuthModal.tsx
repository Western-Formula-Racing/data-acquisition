import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Button } from './Button';
import type { Session } from '@supabase/supabase-js';

interface AuthModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
    const [session, setSession] = useState<Session | null>(null);

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
        });

        return () => subscription.unsubscribe();
    }, []);


    const handleMagicLink = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
                emailRedirectTo: window.location.origin,
            },
        });
        if (error) {
            setMessage({ type: 'error', text: error.message });
        } else {
            setMessage({ type: 'success', text: 'Check your email for the login link!' });
        }
        setLoading(false);
    };

    const handleSignOut = async () => {
        await supabase.auth.signOut();
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="bg-sidebar rounded-xl border border-gray-600 w-[90%] max-w-md p-6 relative animate-in fade-in zoom-in-95 duration-200">
                <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white">✕</button>

                <h2 className="text-2xl font-semibold text-white mb-6">Cloud Sync Login</h2>

                {session ? (
                    <div className="text-center space-y-4">
                        <p className="text-green-400">Logged in as {session.user.email}</p>
                        <p className="text-gray-400 text-sm">Your dashboard config will sync automatically.</p>
                        <Button onClick={handleSignOut} variant="danger" className="w-full">Sign Out</Button>
                    </div>
                ) : (
                    <div className="space-y-6">

                        <form onSubmit={handleMagicLink} className="space-y-3">
                            <input
                                type="email"
                                placeholder="name@example.com"
                                className="w-full bg-zinc-800 text-white px-3 py-2 rounded border border-gray-600 focus:border-blue-500 outline-none"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                            />
                            <Button type="submit" variant="primary" className="w-full" disabled={loading}>
                                {loading ? 'Sending Link...' : 'Send Magic Link'}
                            </Button>
                        </form>

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
