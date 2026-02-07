import { useEffect, useState, useCallback } from 'react';
import { supabase, type UserConfig } from '../lib/supabase';
import type { Session } from '@supabase/supabase-js';

// Debounce helper
function debounce<T extends (...args: any[]) => void>(func: T, wait: number): T {
    let timeout: any;
    return ((...args: any[]) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    }) as T;
}

export function useRemoteConfig() {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        // Skip if Supabase is not configured
        if (!supabase) return;

        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
        });

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
        });

        return () => subscription.unsubscribe();
    }, []);

    const saveConfig = useCallback(
        debounce(async (config: UserConfig['config_data']) => {
            if (!supabase || !session?.user) return;

            console.log('[Sync] Saving config to cloud...', config);

            const { error } = await supabase
                .from('user_configs')
                .upsert({
                    user_id: session.user.id,
                    config_data: config,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'user_id' });

            if (error) {
                console.error('[Sync] Error saving config:', error);
            } else {
                console.log('[Sync] Config saved successfully.');
            }
        }, 2000),
        [session]
    );

    const loadConfig = async (): Promise<UserConfig['config_data'] | null> => {
        if (!supabase || !session?.user) return null;
        setLoading(true);

        const { data, error } = await supabase
            .from('user_configs')
            .select('config_data')
            .eq('user_id', session.user.id)
            .single();

        setLoading(false);

        if (error) {
            if (error.code !== 'PGRST116') {
                console.error('[Sync] Error loading config:', error);
            }
            return null;
        }

        if (data) {
            console.log('[Sync] Config loaded from cloud.');
            return data.config_data;
        }
        return null;
    };

    return {
        session,
        saveConfig,
        loadConfig,
        loading
    };
}
