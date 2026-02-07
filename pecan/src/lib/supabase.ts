import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('Supabase URL or Anon Key missing. syncing will be disabled.');
}

export const supabase = createClient(
    supabaseUrl || '',
    supabaseAnonKey || ''
);

// Types for our config table
export interface UserConfig {
    id?: string;
    user_id: string;
    config_data: {
        plots: any[];
        viewMode: string;
        sortingMethod: string;
        // Add other settings here as needed
    };
    updated_at: string;
}
