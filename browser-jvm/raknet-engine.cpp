#include "RakPeerInterface.h"
#include "RakNetVersion.h"
#include "BitStream.h"
#include <cstdint>
#include <unordered_map>

// Authored ownership/validation boundary. All codec and peer factory operations are upstream.
static std::unordered_map<uint32_t, RakNet::BitStream*> owners;
static uint32_t nextId = 1;

static RakNet::BitStream* find(uint32_t id) {
    auto entry = owners.find(id);
    return entry == owners.end() ? nullptr : entry->second;
}

extern "C" {
const char* rn_candidate_version() {
    return RAKNET_VERSION;
}

// Retained full engine factory/vtable linkage; no browser JNI peer API is admitted.
RakNet::RakPeerInterface* rn_peer_create() {
    return RakNet::RakPeerInterface::GetInstance();
}

void rn_peer_destroy(RakNet::RakPeerInterface* peer) {
    RakNet::RakPeerInterface::DestroyInstance(peer);
}

uint32_t bs_create() {
    if (owners.size() >= 64 || nextId == 0) return 0;
    auto* stream = RakNet::BitStream::GetInstance();
    if (!stream) return 0;
    uint32_t id = nextId++;
    owners.emplace(id, stream);
    return id;
}

int bs_destroy(uint32_t id) {
    auto entry = owners.find(id);
    if (entry == owners.end()) return -1;
    RakNet::BitStream::DestroyInstance(entry->second);
    owners.erase(entry);
    return 0;
}

int bs_live() {
    return static_cast<int>(owners.size());
}

int bs_write(uint32_t id, const unsigned char* data, uint32_t capacity, uint32_t bits, int right) {
    auto* stream = find(id);
    if (!stream) return -1;
    if ((right != 0 && right != 1) || bits > capacity * 8ULL || (bits && !data)) return -2;
    if (bits > 32768 || stream->GetNumberOfBitsUsed() + bits > 32768) return -3;
    stream->WriteBits(data, bits, right != 0);
    return 0;
}

int bs_read(uint32_t id, unsigned char* data, uint32_t capacity, uint32_t bits, int right) {
    auto* stream = find(id);
    if (!stream) return -1;
    if ((right != 0 && right != 1) || bits > capacity * 8ULL || (bits && !data)) return -2;
    return stream->ReadBits(data, bits, right != 0) ? 1 : 0;
}

int bs_bits(uint32_t id) {
    auto* stream = find(id);
    return stream ? static_cast<int>(stream->GetNumberOfBitsUsed()) : -1;
}

int bs_bytes(uint32_t id) {
    auto* stream = find(id);
    return stream ? static_cast<int>(stream->GetNumberOfBytesUsed()) : -1;
}

int bs_read_offset(uint32_t id) {
    auto* stream = find(id);
    return stream ? static_cast<int>(stream->GetReadOffset()) : -1;
}

const unsigned char* bs_data(uint32_t id) {
    auto* stream = find(id);
    return stream ? stream->GetData() : nullptr;
}

int bs_reset(uint32_t id) {
    auto* stream = find(id);
    if (!stream) return -1;
    stream->Reset();
    return 0;
}

int bs_reset_read(uint32_t id) {
    auto* stream = find(id);
    if (!stream) return -1;
    stream->ResetReadPointer();
    return 0;
}

int bs_align_write(uint32_t id) {
    auto* stream = find(id);
    if (!stream) return -1;
    stream->AlignWriteToByteBoundary();
    return 0;
}

int bs_align_read(uint32_t id) {
    auto* stream = find(id);
    if (!stream) return -1;
    stream->AlignReadToByteBoundary();
    return 0;
}
}
