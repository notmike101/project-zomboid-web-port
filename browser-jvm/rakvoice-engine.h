#include "PluginInterface2.h"
#include "SimpleMutex.h"
#include <memory>

// Shipped RakVoice.Init creates no codec: Opus owners begin only when a channel opens.
class BrowserRakVoice : public RakNet::PluginInterface2 {
public:
    unsigned bufferBytes=0;
    int complexity=2;
    bool initialized=false;
    std::unique_ptr<RakNet::SimpleMutex> mutex;
};
static std::unique_ptr<BrowserRakVoice> voiceOwner;
static RakNet::RakPeerInterface* voicePeer=nullptr;

extern "C" int rn_voice_init(unsigned bytes) {
    if(voiceOwner&&voiceOwner->initialized)return -1;
    if(!voiceOwner)voiceOwner.reset(new BrowserRakVoice());
    voiceOwner->mutex.reset(new RakNet::SimpleMutex());
    voiceOwner->bufferBytes=bytes;
    if(!voicePeer)voicePeer=RakNet::RakPeerInterface::GetInstance();
    if(!voicePeer)return -2;
    voicePeer->AttachPlugin(voiceOwner.get());
    voiceOwner->initialized=true;return 0;
}
extern "C" int rn_voice_set_complexity(int value) {
    if(!voiceOwner)return -1;
    voiceOwner->complexity=value;return 0;
}
extern "C" int rn_voice_state(int* output) {
    if(!voiceOwner||!output)return -1;
    output[0]=voiceOwner->bufferBytes;output[1]=voiceOwner->complexity;
    output[2]=voiceOwner->GetRakPeerInterface()==voicePeer;
    output[3]=voiceOwner->initialized;return 0;
}
extern "C" int rn_voice_deinit() {
    if(!voiceOwner||!voiceOwner->initialized)return -1;
    voicePeer->DetachPlugin(voiceOwner.get());voiceOwner->initialized=false;return 0;
}
extern "C" int rn_voice_destroy() {
    if(voiceOwner&&voiceOwner->initialized)rn_voice_deinit();
    voiceOwner.reset();
    if(voicePeer)RakNet::RakPeerInterface::DestroyInstance(voicePeer);
    voicePeer=nullptr;return 0;
}
