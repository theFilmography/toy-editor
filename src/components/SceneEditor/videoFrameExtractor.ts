// Video Frame Extraction Utility for Timeline Keyframes
// Extracts video frames at specific timestamps for timeline visualization

export interface VideoFrameOptions {
    width?: number;
    height?: number;
    quality?: number; // 0-1, default 0.8
}

/**
 * Warm up CORS cache by making a simple HEAD request
 */
const warmupCORSCache = async (videoUrl: string): Promise<void> => {
    try {
        await fetch(videoUrl, { 
            method: 'HEAD',
            mode: 'cors'
        });
    } catch (error) {
        // Ignore errors - this is just for cache warming
    }
};

/**
 * Extract a single frame from a video at a specific timestamp
 */
export const extractVideoFrame = async (
    videoUrl: string,
    timeInSeconds: number,
    options: VideoFrameOptions = {}
): Promise<string> => {
    const { width = 160, height = 90, quality = 0.8 } = options;

    // For R2 URLs, warm up CORS cache first
    if (videoUrl.includes('.r2.dev')) {
        await warmupCORSCache(videoUrl);
    }

    // Try with crossOrigin first, then fallback without it
    try {
        return await extractVideoFrameWithCORS(videoUrl, timeInSeconds, { width, height, quality }, true);
    } catch (error) {
        return await extractVideoFrameWithCORS(videoUrl, timeInSeconds, { width, height, quality }, false);
    }
};

/**
 * Internal function to extract frame with or without CORS
 */
const extractVideoFrameWithCORS = async (
    videoUrl: string,
    timeInSeconds: number,
    options: VideoFrameOptions,
    useCORS: boolean
): Promise<string> => {
    const { width = 160, height = 90, quality = 0.8 } = options;

    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        if (!ctx) {
            reject(new Error('Could not get canvas context'));
            return;
        }

        // Set canvas dimensions
        canvas.width = width;
        canvas.height = height;

        // Only set crossOrigin if needed
        if (useCORS) {
            video.crossOrigin = 'anonymous';
        }
        video.preload = 'metadata';

        video.onloadedmetadata = () => {
            // Clamp time to video duration
            const seekTime = Math.min(timeInSeconds, video.duration);
            if (!Number.isFinite(seekTime)) {
                reject(new Error(`Cannot seek to non-finite time: ${seekTime}`));
                return;
            }
            video.currentTime = seekTime;
        };

        const extractFrame = () => {
            try {
                // Draw video frame to canvas
                ctx.drawImage(video, 0, 0, width, height);

                // Convert canvas to data URL
                const dataUrl = canvas.toDataURL('image/jpeg', quality);

                // Clean up
                video.remove();
                canvas.remove();

                resolve(dataUrl);
            } catch (error) {
                reject(error);
            }
        };

        video.onseeked = extractFrame;

        video.onerror = () => {
            reject(new Error(`Failed to load video${useCORS ? ' (CORS)' : ''}`));
        };

        video.ontimeupdate = () => {
            // Sometimes onseeked doesn't fire, use timeupdate as fallback
            if (Math.abs(video.currentTime - Math.min(timeInSeconds, video.duration)) < 0.1) {
                extractFrame();
            }
        };

        video.src = videoUrl;
    });
};

/**
 * Extract multiple frames from a video at specified timestamps
 */
export const extractVideoFrames = async (
    videoUrl: string,
    timestamps: number[],
    options: VideoFrameOptions = {}
): Promise<string[]> => {
    const frames: string[] = [];

    try {
        // Extract frames sequentially to avoid browser resource issues
        for (const timestamp of timestamps) {
            const frameUrl = await extractVideoFrame(videoUrl, timestamp, options);
            frames.push(frameUrl);
        }

        return frames;
    } catch (error) {
        // Return empty array so component can handle gracefully
        return [];
    }
};

/**
 * Generate evenly spaced timestamps for keyframe extraction
 */
export const generateKeyframeTimestamps = (
    videoDuration: number,
    keyframeCount: number,
    trimStart: number = 0,
    trimEnd: number = 0
): number[] => {
    const effectiveDuration = videoDuration - trimStart - trimEnd;
    const timestamps: number[] = [];

    if (keyframeCount === 1) {
        // Single frame at middle of clip
        timestamps.push(trimStart + effectiveDuration / 2);
    } else {
        // Evenly distributed frames
        for (let i = 0; i < keyframeCount; i++) {
            const progress = i / (keyframeCount - 1);
            const timestamp = trimStart + (progress * effectiveDuration);
            timestamps.push(timestamp);
        }
    }

    return timestamps;
};

/**
 * Get video metadata (duration, dimensions) without downloading entire file
 */
export const getVideoMetadata = async (videoUrl: string): Promise<{
    duration: number;
    width: number;
    height: number;
}> => {
    // For R2 URLs, warm up CORS cache first
    if (videoUrl.includes('.r2.dev')) {
        await warmupCORSCache(videoUrl);
    }

    // Try with crossOrigin first, then fallback without it
    try {
        return await getVideoMetadataWithCORS(videoUrl, true);
    } catch (error) {
        return await getVideoMetadataWithCORS(videoUrl, false);
    }
};

/**
 * Internal function to get metadata with or without CORS
 */
const getVideoMetadataWithCORS = async (videoUrl: string, useCORS: boolean): Promise<{
    duration: number;
    width: number;
    height: number;
}> => {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');

        // Only set crossOrigin if needed
        if (useCORS) {
            video.crossOrigin = 'anonymous';
        }

        video.onloadedmetadata = () => {
            const metadata = {
                duration: video.duration,
                width: video.videoWidth,
                height: video.videoHeight
            };

            video.remove();
            resolve(metadata);
        };

        video.onerror = () => {
            reject(new Error(`Failed to load video metadata${useCORS ? ' (CORS)' : ''}`));
        };

        video.preload = 'metadata';
        video.src = videoUrl;
    });
}; 