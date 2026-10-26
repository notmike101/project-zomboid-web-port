#include <cstdint>
#include <cstring>
#define STB_DXT_IMPLEMENTATION
#include "stb_dxt.h"

// One four-row strip only; the caller owns upload storage and frees this scratch.
extern "C" int tc_encode_row(const uint8_t* rgba, unsigned width, unsigned rows, uint8_t* output) {
    if (!rgba || !output || width == 0 || width > 32768 || rows == 0 || rows > 4) return 0;
    uint8_t block[64];
    const unsigned blocks = (width + 3) / 4;
    for (unsigned x = 0; x < blocks; ++x) {
        for (unsigned y = 0; y < 4; ++y) {
            const unsigned sourceY = y < rows ? y : rows - 1;
            for (unsigned column = 0; column < 4; ++column) {
                const unsigned sourceX = x * 4 + column < width ? x * 4 + column : width - 1;
                std::memcpy(block + (y * 4 + column) * 4, rgba + (sourceY * width + sourceX) * 4, 4);
            }
        }
        stb_compress_dxt_block(output + x * 16, block, 1, STB_DXT_HIGHQUAL);
    }
    return static_cast<int>(blocks * 16);
}
