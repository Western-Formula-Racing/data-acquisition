// Jitsi Meet configuration.
// Custom dynamic configuration for WFR Comms (Localhost/RPI support)

var config = {};

config.hosts = {};
config.hosts.domain = 'meet.jitsi';

var subdir = '<!--# echo var="subdir" default="" -->';
var subdomain = '<!--# echo var="subdomain" default="" -->';
if (subdir.startsWith('<!--')) {
    subdir = '';
}
if (subdomain) {
    subdomain = subdomain.substring(0, subdomain.length - 1).split('.').join('_').toLowerCase() + '.';
}
config.hosts.muc = 'muc.' + subdomain + 'meet.jitsi';

// DYNAMIC CONFIGURATION FOR ANY HOST (LOCALHOST OR RPI IP)
// Forces HTTP/WS to avoid SSL issues on local network
config.bosh = 'http://' + window.location.host + '/' + subdir + 'http-bind';
config.websocket = 'ws://' + window.location.host + '/' + subdir + 'xmpp-websocket';

config.bridgeChannel = {
    preferSctp: true
};

config.resolution = 720;
config.constraints = {
    video: {
        height: { ideal: 720, max: 720, min: 180 },
        width: { ideal: 1280, max: 1280, min: 320 },
    }
};

config.startVideoMuted = 10;
config.startWithVideoMuted = false;

config.flags = {
    sourceNameSignaling: true,
    sendMultipleVideoStreams: true,
    receiveMultipleVideoStreams: true
};

config.enableNoAudioDetection = true;
config.enableTalkWhileMuted = false;
config.disableAP = false;
config.disableAGC = false;

config.audioQuality = {
    stereo: false
};

config.startAudioOnly = false;
config.startAudioMuted = 10;
config.startWithAudioMuted = false;
config.startSilent = false;
config.enableOpusRed = false;
config.disableAudioLevels = false;
config.enableNoisyMicDetection = true;

config.p2p = {
    enabled: true,
    codecPreferenceOrder: ["AV1", "VP9", "VP8", "H264"],
    mobileCodecPreferenceOrder: ["VP8", "VP9", "H264", "AV1"]
};

config.hideAddRoomButton = false;

config.localRecording = {
    disable: false,
    notifyAllParticipants: false,
    disableSelfRecording: false
};

config.analytics = {};

config.enableCalendarIntegration = false;

config.prejoinConfig = {
    enabled: false,
    hideDisplayName: false
};

config.welcomePage = {
    disabled: false
};

config.enableClosePage = false;
config.requireDisplayName = false;
config.disableProfile = false;
config.roomPasswordNumberOfDigits = false;

config.transcription = {
    enabled: false,
    disableClosedCaptions: true,
    translationLanguages: [],
    translationLanguagesHead: ['en'],
    useAppLanguage: true,
    preferredLanguage: 'en-US',
    disableStartForAll: false,
    autoCaptionOnRecord: false,
};

config.deploymentInfo = {};
config.disableDeepLinking = false;

config.videoQuality = {};
config.videoQuality.codecPreferenceOrder = ["AV1", "VP9", "VP8", "H264"];
config.videoQuality.mobileCodecPreferenceOrder = ["VP8", "VP9", "H264", "AV1"];
config.videoQuality.enableAdaptiveMode = true;
config.videoQuality.av1 = {};
config.videoQuality.h264 = {};
config.videoQuality.vp8 = {};
config.videoQuality.vp9 = {};

config.disableReactions = false;
config.disablePolls = false;

config.remoteVideoMenu = {
    disabled: false,
    disableKick: false,
    disableGrantModerator: false,
    disablePrivateChat: false
};

config.e2eping = {
    enabled: false
};

config.whiteboard = {
    enabled: false,
};

config.testing = {
    enableCodecSelectionAPI: true
};
