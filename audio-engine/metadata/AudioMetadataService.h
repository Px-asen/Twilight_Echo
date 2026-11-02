#pragma once

#include <string>
#include "../decoder/SeekableInput.h"

namespace twilight::audio {

std::string readMetadataJson(const std::string& source,
    std::shared_ptr<const SeekableInputFactory> inputFactory = {});

}  // namespace twilight::audio
