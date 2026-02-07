import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Cloud sync is disabled if credentials are missing (graceful degradation)
// This prevents crashes in Docker/CI environments without Supabase config
export const supabase: SupabaseClient | null = (supabaseUrl && supabaseAnonKey)
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

export const isSupabaseConfigured = supabase !== null;

// Types for our config table
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
