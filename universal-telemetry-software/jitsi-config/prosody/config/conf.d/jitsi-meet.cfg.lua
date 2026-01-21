admins = {
    

    

    "focus@auth.meet.jitsi",
    "jvb@auth.meet.jitsi"
}

unlimited_jids = {
    "focus@auth.meet.jitsi",
    "jvb@auth.meet.jitsi"
}

plugin_paths = { "/prosody-plugins-custom", "/prosody-plugins/", "/prosody-plugins-contrib" }

muc_mapper_domain_base = "meet.jitsi";
muc_mapper_domain_prefix = "muc";

recorder_prefixes = { "recorder@hidden.meet.jitsi" };

transcriber_prefixes = { "transcriber@hidden.meet.jitsi" };

http_default_host = "meet.jitsi"







consider_bosh_secure = true;
consider_websocket_secure = true;


smacks_max_unacked_stanzas = 5;
smacks_hibernation_time = 60;
smacks_max_old_sessions = 1;




VirtualHost "meet.jitsi"

    authentication = "jitsi-anonymous"

    ssl = {
        key = "/config/certs/meet.jitsi.key";
        certificate = "/config/certs/meet.jitsi.crt";
    }
    modules_enabled = {
        "bosh";
        "features_identity";
        
        "websocket";
        "smacks"; -- XEP-0198: Stream Management
        
        "conference_duration";
        
        
        "muc_breakout_rooms";
        
        
        
        
        

    }

    main_muc = "muc.meet.jitsi"
    

    

    
    breakout_rooms_muc = "breakout.meet.jitsi"
    

    c2s_require_encryption = true

    

    

VirtualHost "auth.meet.jitsi"
    ssl = {
        key = "/config/certs/auth.meet.jitsi.key";
        certificate = "/config/certs/auth.meet.jitsi.crt";
    }
    modules_enabled = {
        "limits_exception";
        "smacks";
    }
    authentication = "internal_hashed"
    smacks_hibernation_time = 15;



Component "internal-muc.meet.jitsi" "muc"
    storage = "memory"
    modules_enabled = {
        "muc_hide_all";
        "muc_filter_access";
        }
    restrict_room_creation = true
    muc_filter_whitelist="auth.meet.jitsi"
    muc_room_locking = false
    muc_room_default_public_jids = true
    muc_room_cache_size = 1000
    muc_tombstones = false
    muc_room_allow_persistent = false

Component "muc.meet.jitsi" "muc"
    restrict_room_creation = true
    storage = "memory"
    modules_enabled = {
        "muc_hide_all";
        "muc_meeting_id";
        
        "muc_domain_mapper";
        
        "muc_password_whitelist";
        
    }

    -- The size of the cache that saves state for IP addresses
    rate_limit_cache_size = 10000;

    muc_room_cache_size = 10000
    muc_room_locking = false
    muc_room_default_public_jids = true
    
    muc_password_whitelist = {
        "focus@auth.meet.jitsi";
    }
    muc_tombstones = false
    muc_room_allow_persistent = false

Component "focus.meet.jitsi" "client_proxy"
    target_address = "focus@auth.meet.jitsi"

Component "speakerstats.meet.jitsi" "speakerstats_component"
    muc_component = "muc.meet.jitsi"


Component "endconference.meet.jitsi" "end_conference"
    muc_component = "muc.meet.jitsi"







Component "breakout.meet.jitsi" "muc"
    storage = "memory"
    restrict_room_creation = true
    muc_room_cache_size = 10000
    muc_room_locking = false
    muc_room_default_public_jids = true
    muc_tombstones = false
    muc_room_allow_persistent = false
    modules_enabled = {
        "muc_hide_all";
        "muc_meeting_id";
        }


Component "metadata.meet.jitsi" "room_metadata_component"
    muc_component = "muc.meet.jitsi"
    breakout_rooms_component = "breakout.meet.jitsi"




Component "polls.meet.jitsi" "polls_component"
