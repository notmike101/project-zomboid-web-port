#include <array>
#include <cmath>
#include <cstdint>
#include <vector>
#include "earcut.hpp"

// Data-only bridge to pinned upstream Mapbox Earcut; no game initialization.
extern "C" int triangulate(const double* xy, int vertices, const int* ends, int rings,
                           int* output, int capacity) {
    if (!xy || !ends || !output || vertices < 3 || vertices > 32767 || rings < 1 || rings > vertices / 3 || capacity < 0) return -1;
    std::vector<std::vector<std::array<double, 2>>> polygon;
    int start = 0;
    for (int ring = 0; ring < rings; ++ring) {
        int end = ends[ring];
        if (end < start + 3 || end > vertices) return -2;
        std::vector<std::array<double, 2>> points;
        for (int point = start; point < end; ++point) {
            double x = xy[point * 2], y = xy[point * 2 + 1];
            if (!std::isfinite(x) || !std::isfinite(y)) return -3;
            points.push_back({x, y});
        }
        polygon.push_back(std::move(points));
        start = end;
    }
    if (start != vertices) return -2;
    const auto indices = mapbox::earcut<uint32_t>(polygon);
    if (indices.size() > static_cast<size_t>(capacity)) return -4;
    for (size_t index = 0; index < indices.size(); ++index) output[index] = indices[index];
    return static_cast<int>(indices.size());
}
