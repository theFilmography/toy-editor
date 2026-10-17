import React, { useState, useEffect, useRef } from 'react';
import { useCanvas } from '../../contexts/TimelineContext';
import { NodeType, MediaNode } from '../../types/timeline';
import { Play, Pause, SkipForward, SkipBack, Minimize2, Camera, Upload } from 'lucide-react';
import { Button } from '../ui/button';
import mediaService from '../../services/mediaService';
import { VirtualTimelineManager, VideoPlayerInstruction, TimelineState } from './VirtualTimelineManager';
import { VideoFrameExtractOperation } from '../../operations/VideoFrameExtractOperation';
import { toast } from 'sonner';

interface VideoPreviewAreaProps {
    virtualTimeline?: VirtualTimelineManager;
    onToggleVideoPreview?: () => void;
}

const VideoPreviewArea: React.FC<VideoPreviewAreaProps> = ({ virtualTimeline, onToggleVideoPreview }) => {
    const { nodes, stateManager } = useCanvas();

    // Simplified state - only what's needed for display
    const [currentInstruction, setCurrentInstruction] = useState<VideoPlayerInstruction | null>(null);
    const [mediaUrl, setMediaUrl] = useState<string>('');
    const [isPlaying, setIsPlaying] = useState(false);
    const [globalTime, setGlobalTime] = useState(0);
    const [isVideoLoading, setIsVideoLoading] = useState(false);
    const [isExtractingFrame, setIsExtractingFrame] = useState(false);

    // Single video ref - no complex state management
    const videoRef = useRef<HTMLVideoElement>(null);
    const lastClipIdRef = useRef<string>('');

    // Get the scene editor data
    const sceneEditor = stateManager.getSceneEditor();

    // Single VTM subscription - drives all behavior (NEW ARCHITECTURE)
    useEffect(() => {
        if (!virtualTimeline) return;

        // Subscribe to VTM state changes
        const unsubscribeInstruction = virtualTimeline.onVideoPlayerInstruction((instruction) => {
            setCurrentInstruction(instruction);
        });

        const unsubscribeTime = virtualTimeline.onCurrentTimeChange((time) => {
            setGlobalTime(time);
        });

        const unsubscribeState = virtualTimeline.onTimelineChange((state) => {
            setIsPlaying(state.isPlaying);
        });

        // Get initial state
        const initialState = virtualTimeline.getTimelineState();
        setGlobalTime(initialState.currentTime);
        setIsPlaying(initialState.isPlaying);
        setCurrentInstruction({
            clip: initialState.currentClip?.clip || null,
            seekTime: initialState.currentClip?.clipTime || 0
        });

        return () => {
            unsubscribeInstruction();
            unsubscribeTime();
            unsubscribeState();
        };
    }, [virtualTimeline]);

    // Load media URL when instruction changes
    useEffect(() => {
        const loadMediaUrl = async () => {
            console.log('🎬 VideoPreviewArea: Loading media for instruction:', {
                hasInstruction: !!currentInstruction,
                hasClip: !!currentInstruction?.clip,
                clipId: currentInstruction?.clip?.id,
                mediaNodeId: currentInstruction?.clip?.mediaNodeId,
                nodesCount: nodes.length
            });

            if (!currentInstruction?.clip) {
                console.log('🎬 No clip in instruction, clearing media URL');
                setMediaUrl('');
                return;
            }

            const node = nodes.find(node => node.id === currentInstruction.clip.mediaNodeId);
            console.log('🎬 Found node for mediaNodeId:', currentInstruction.clip.mediaNodeId, '→', node?.id, node?.type);

            if (node && (node.type === NodeType.IMAGE || node.type === NodeType.VIDEO)) {
                const mediaNode = node as MediaNode;
                if (mediaNode.data.url) {
                    try {
                        const url = await mediaService.getMediaUrl(mediaNode.data.url);
                        console.log('🎬 Loaded media URL:', url.substring(0, 50) + '...');
                        setMediaUrl(url);
                    } catch (error) {
                        console.error('🎬 Error loading media URL:', error);
                        setMediaUrl('');
                    }
                } else {
                    console.log('🎬 No data.url on media node');
                    setMediaUrl('');
                }
            } else {
                console.log('🎬 Node not found or wrong type, clearing media URL');
                setMediaUrl('');
            }
        };

        loadMediaUrl();

        return () => {
            // Clean up any blob URLs
            if (mediaUrl && mediaUrl.startsWith('blob:')) {
                URL.revokeObjectURL(mediaUrl);
            }
        };
    }, [currentInstruction?.clip?.id, nodes]);

    // Get the current media node
    const getCurrentMediaNode = () => {
        if (!currentInstruction?.clip) return null;

        const node = nodes.find(node => node.id === currentInstruction.clip.mediaNodeId);
        if (node && (node.type === NodeType.IMAGE || node.type === NodeType.VIDEO)) {
            return node as MediaNode;
        }

        return null;
    };

    // Reactive video seeking - seeks video to match VTM time (NEW ARCHITECTURE)
    useEffect(() => {
        if (!currentInstruction?.clip || !videoRef.current) return;

        const currentMediaNode = getCurrentMediaNode();
        if (currentMediaNode?.type !== NodeType.VIDEO || !mediaUrl) return;

        const video = videoRef.current;
        const clipId = currentInstruction.clip.id;
        const seekTime = currentInstruction.seekTime + (currentInstruction.clip.trimStart || 0);
        const canSeek = Number.isFinite(seekTime);

        // Handle clip changes
        if (lastClipIdRef.current !== clipId) {
            // Don't show loading state - keep previous frame visible for smooth transition
            // setIsVideoLoading(true); // Commented out to prevent blank screen
            video.src = mediaUrl;
            lastClipIdRef.current = clipId;

            const handleCanPlay = () => {
                // Video is ready to play at the seeked position
                if (canSeek) {
                    video.currentTime = seekTime;
                }
                setIsVideoLoading(false);

                // If we should be playing, ensure video starts
                if (isPlaying) {
                    video.play().catch(err => {
                        if (err.name !== 'AbortError') {
                            console.warn('Failed to play video after clip change:', err);
                        }
                    });
                }
            };

            const handleError = () => {
                console.error('Failed to load video:', mediaUrl);
                setIsVideoLoading(false);
            };

            // Use 'canplay' instead of 'loadeddata' for smoother transition
            video.addEventListener('canplay', handleCanPlay, { once: true });
            video.addEventListener('error', handleError, { once: true });

            return () => {
                video.removeEventListener('canplay', handleCanPlay);
                video.removeEventListener('error', handleError);
            };
        } else {
            // Same clip, just seek to new position
            if (canSeek && video.readyState >= 2 && Math.abs(video.currentTime - seekTime) > 0.05) {
                video.currentTime = seekTime;
            }
        }
    }, [currentInstruction?.clip?.id, currentInstruction?.seekTime, mediaUrl, isPlaying]);

    // Simple play/pause control - no timing logic (NEW ARCHITECTURE)
    useEffect(() => {
        const currentMediaNode = getCurrentMediaNode();

        if (videoRef.current && currentMediaNode?.type === NodeType.VIDEO) {
            const video = videoRef.current;

            if (isPlaying && !isVideoLoading && video.readyState >= 2) {
                video.play().catch(err => {
                    if (err.name !== 'AbortError') {
                        console.warn('Failed to play video:', err);
                    }
                });
            } else {
                if (!video.paused) {
                    video.pause();
                }
            }
        }
    }, [isPlaying, isVideoLoading]);

    // Control handlers - only update VTM, no direct timing logic
    const togglePlayback = () => {
        if (virtualTimeline) {
            virtualTimeline.setPlaying(!isPlaying);
        }
    };

    const skipNext = () => {
        if (!virtualTimeline) return;

        const currentClip = virtualTimeline.getCurrentClip();
        if (currentClip) {
            const nextTime = currentClip.clipEndTime;
            virtualTimeline.setCurrentTime(nextTime);
        }
    };

    const skipPrevious = () => {
        if (!virtualTimeline) return;

        const currentClip = virtualTimeline.getCurrentClip();
        if (currentClip) {
            if (currentClip.clipTime > 2) {
                virtualTimeline.setCurrentTime(currentClip.clipStartTime);
            } else {
                const prevTime = Math.max(0, currentClip.clipStartTime - 0.1);
                virtualTimeline.setCurrentTime(prevTime);
            }
        }
    };

    // Handle Extract Frame from timeline
    const handleExtractCurrentFrame = async () => {
        if (!videoRef.current || !currentInstruction?.clip || !stateManager) return;

        // Only works for videos
        const currentMediaNode = getCurrentMediaNode();
        if (currentMediaNode?.type !== NodeType.VIDEO) {
            toast.error('Frame extraction only works with video clips');
            return;
        }

        // Prevent multiple simultaneous extractions
        if (isExtractingFrame) return;

        try {
            setIsExtractingFrame(true);

            const timestamp = videoRef.current.currentTime;
            const videoNodeId = currentInstruction.clip.mediaNodeId;

            // Format time for display
            const formatTime = (time: number) => {
                const minutes = Math.floor(time / 60);
                const seconds = Math.floor(time % 60);
                return `${minutes}:${seconds.toString().padStart(2, '0')}`;
            };

            toast.info(`Extracting frame at ${formatTime(timestamp)} as image node on canvas...`);

            // Get video node for positioning
            const videoNode = nodes.find(n => n.id === videoNodeId);
            if (!videoNode) {
                toast.error('Video node not found');
                setIsExtractingFrame(false);
                return;
            }

            // Position new node to the right of video (like grid split)
            const gap = 50;
            const videoNodeWidth = 400;

            // Check if there are existing children to stack vertically
            const videoMediaNode = videoNode as MediaNode;
            const childrenCount = videoMediaNode.data?.childrenIds?.length || 0;
            const verticalOffset = childrenCount * 300; // Approximate height + gap

            const position = {
                x: videoNode.position.x + videoNodeWidth + gap,
                y: videoNode.position.y + verticalOffset
            };

            // Create and execute operation
            const operation = new VideoFrameExtractOperation(
                videoNodeId,
                timestamp,
                position
            );

            await stateManager.getOperationManager().executeWithContext(
                operation,
                stateManager
            );

            toast.success(`Frame extracted at ${formatTime(timestamp)} - Check canvas for new image node!`);
            setIsExtractingFrame(false);

            // Timeline stays open for continued editing

        } catch (error) {
            console.error('Frame extraction failed:', error);
            toast.error('Failed to extract frame');
            setIsExtractingFrame(false);
        }
    };

    const currentMediaNode = getCurrentMediaNode();

    // File input ref for upload
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;

        const { addMediaFromFile, addMediaToTimeline } = useCanvas() as any;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            await addMediaFromFile(file);
            // Auto-add to timeline after upload
            setTimeout(() => {
                const nodes = stateManager.getNodes();
                const lastNode = nodes[nodes.length - 1];
                if (lastNode) {
                    addMediaToTimeline(lastNode.id);
                }
            }, 100);
        }

        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    // Show empty state if no VTM or no clips
    if (!virtualTimeline || !sceneEditor?.cells.length) {
        return (
            <div className="video-preview-area">
                <div className="text-center text-filmforge-text-light">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*,image/*"
                        multiple
                        onChange={handleFileUpload}
                        className="hidden"
                        id="video-preview-upload"
                    />
                    <Upload className="w-16 h-16 mx-auto mb-4 opacity-50" />
                    <p className="text-lg mb-4">Add media to timeline to start editing</p>
                    <label
                        htmlFor="video-preview-upload"
                        className="inline-flex items-center gap-2 px-6 py-3 bg-black hover:bg-gray-800 text-white cursor-pointer transition-colors rounded-md font-medium"
                    >
                        <Upload className="w-5 h-5" />
                        Upload Videos & Images
                    </label>
                    <p className="text-sm mt-4 opacity-60">Supports MP4, MOV, JPG, PNG</p>
                </div>
            </div>
        );
    }

    const totalDuration = virtualTimeline.getTotalDuration();
    const currentClip = virtualTimeline.getCurrentClip();

    return (
        <div className="video-preview-area relative">
            {/* Top-right controls */}
            <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
                {/* Extract Frame button - only show for video clips */}
                {currentMediaNode?.type === NodeType.VIDEO && (
                    <button
                        onClick={handleExtractCurrentFrame}
                        disabled={isExtractingFrame}
                        className="bg-transparent hover:bg-white/10 text-white flex items-center gap-2 px-3 py-2 rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Camera className="w-4 h-4 text-white" />
                        <span className="text-white text-sm">
                            {isExtractingFrame ? 'Extracting...' : 'Extract Frame'}
                        </span>
                    </button>
                )}
            </div>

            <div className="relative w-full h-full flex items-center justify-center">
                {mediaUrl && currentInstruction?.clip ? (
                    currentMediaNode?.type === NodeType.VIDEO ? (
                        <video
                            ref={videoRef}
                            src={mediaUrl}
                            className="max-w-full max-h-full object-contain scene-editor-video-preview"
                            muted
                            preload="auto"
                            playsInline
                        />
                    ) : (
                        <img
                            src={mediaUrl}
                            alt="Preview"
                            className="max-w-full max-h-full object-contain scene-editor-video-preview"
                        />
                    )
                ) : isVideoLoading ? (
                    <div className="text-center text-white">
                        <div className="flex items-center justify-center mb-2">
                            <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        </div>
                        <p className="text-sm">Loading...</p>
                    </div>
                ) : (
                    <div className="text-center text-white">
                        <p className="text-sm">Loading media...</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default VideoPreviewArea;