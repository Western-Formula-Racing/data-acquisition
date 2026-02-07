import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { supabase } from '../lib/supabase';

/**
 * Handles the Supabase PKCE auth callback.
 * When a user clicks a magic link, Supabase redirects here with a `code` query parameter.
 * This component exchanges the code for a session, then redirects to the dashboard.
 */
export default function AuthCallback() {
    const navigate = useNavigate();
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        const handleCallback = async () => {
            if (!supabase) {
                if (!cancelled) setError('Authentication is not configured.');
                return;
            }

            const url = new URL(window.location.href);
            const code = url.searchParams.get('code');

            if (!code) {
                if (!cancelled) setError('No authentication code found. Please try signing in again.');
                return;
            }

            const { error } = await supabase.auth.exchangeCodeForSession(code);
            if (cancelled) return;

            if (error) {
                setError(error.message);
                return;
            }

            // Redirect to dashboard after successful authentication
            navigate('/dashboard', { replace: true });
        };

        handleCallback();

        return () => { cancelled = true; };
    }, [navigate]);

    if (error) {
        return (
            <div className="flex items-center justify-center h-screen bg-zinc-900">
                <div className="text-center space-y-4 p-6">
                    <p className="text-red-400 text-lg">Authentication Error</p>
                    <p className="text-gray-400">{error}</p>
                    <button
                        onClick={() => navigate('/', { replace: true })}
                        className="text-blue-400 hover:text-blue-300 underline"
                    >
                        Return Home
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center h-screen bg-zinc-900">
            <div className="text-center space-y-2">
                <p className="text-white text-lg">Signing you in...</p>
                <p className="text-gray-400">Please wait while we complete authentication.</p>
            </div>
        </div>
    );
}
