import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Cloud sync is disabled if credentials are missing (graceful degradation)

export const supabase = createClient(
    supabaseUrl || '',
    supabaseAnonKey || ''
);

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
