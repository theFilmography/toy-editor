/**
 * Virtual Timeline Manager - Global Timeline State Management
 * 
 * Serves as the single source of truth for timeline state, managing the complex
 * mapping between global timeline time and individual clip positions while
 * integrating seamlessly with the existing universal alignment system.
 */

import { SceneEditorCell, MediaNode, NodeType } from '../../types/timeline';
import { ZoomSystem } from './zoomSystem';

// Core interfaces for timeline state management
export interface ClipPosition {
    clipIndex: number;      // Which clip in the sequence  
    clipTime: number;       // Time within that clip (handles trimming)
    clip: SceneEditorCell;  // The actual clip data
    clipStartTime: number;  // Global start time of this clip
    clipEndTime: number;    // Global end time of this clip
}

export interface TimelineState {
    totalDuration: number;
    currentTime: number;
    currentClip: ClipPosition | null;
    isPlaying: boolean;
}

export interface VideoPlayerInstruction {
    clip: SceneEditorCell | null;
    seekTime: number;
    mediaUrl?: string;
}

// Event callback types
export type TimelineChangeCallback = (state: TimelineState) => void;
export type CurrentTimeChangeCallback = (globalTime: number) => void;
export type VideoPlayerCallback = (instruction: VideoPlayerInstruction) => void;

export interface VirtualTimelineManager {
    // Core time mapping functions
    globalTimeToClipPosition(globalTime: number): ClipPosition | null;
    clipPositionToGlobalTime(clipIndex: number, clipTime: number): number;

    // Timeline state management
    getCurrentTime(): number;
    setCurrentTime(globalTime: number): void;
    getTotalDuration(): number;
    updateTimeline(cells: SceneEditorCell[]): void;

    // Integration with existing zoom system
    getPlayheadPixelPosition(globalTime: number): number;
    getTimeFromPixelClick(pixelX: number): number;
    updateZoomSystem(newZoomSystem: ZoomSystem): void;

    // Playback state
    setPlaying(isPlaying: boolean): void;
    isPlaying(): boolean;

    // Master Clock Control (NEW)
    startMasterClock(): void;
    stopMasterClock(): void;

    // Event system for component synchronization
    onTimelineChange(callback: TimelineChangeCallback): () => void;
    onCurrentTimeChange(callback: CurrentTimeChangeCallback): () => void;
    onVideoPlayerInstruction(callback: VideoPlayerCallback): () => void;

    // Utility methods
    getCurrentClip(): ClipPosition | null;
    getTimelineState(): TimelineState;
    validateTimelineIntegrity(): { isValid: boolean; errors: string[] };

    // Drag operation support
    validateClipMove(clipId: string, newStartTime: number): {
        valid: boolean;
        suggestedTime?: number;
        conflicts?: string[];
    };
    adjustPlayheadAfterClipMove(clipId: string, oldStartTime: number, newStartTime: number): void;
    updateTimelineAfterDrag(cells: SceneEditorCell[], draggedClipId?: string, oldStartTime?: number, newStartTime?: number): void;
}

/**
 * Implementation of Virtual Timeline Manager
 * Integrates with existing zoom system and maintains backward compatibility
 */
export class VirtualTimelineManagerImpl implements VirtualTimelineManager {
    private cells: SceneEditorCell[] = [];
    private currentTime: number = 0;
    private playing: boolean = false;
    private totalDuration: number = 0;

    // Master Clock State (NEW)
    private masterClockRef: number | null = null;
    private lastFrameTime: number = 0;

    // Event subscribers
    private timelineChangeCallbacks: TimelineChangeCallback[] = [];
    private currentTimeChangeCallbacks: CurrentTimeChangeCallback[] = [];
    private videoPlayerCallbacks: VideoPlayerCallback[] = [];

    constructor(
        private zoomSystem: ZoomSystem,
        initialCells: SceneEditorCell[] = []
    ) {
        this.updateTimeline(initialCells);

        // Cleanup on page unload
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', () => {
                this.stopMasterClock();
            });
        }
    }

    // Core time mapping functions
    globalTimeToClipPosition(globalTime: number): ClipPosition | null {
        // Clamp time to valid range
        const clampedTime = Math.max(0, Math.min(globalTime, this.totalDuration));

        // Find clip that contains this global time
        for (let i = 0; i < this.cells.length; i++) {
            const cell = this.cells[i];
            const startTime = cell.startTime || 0;
            const effectiveDuration = this.getEffectiveDuration(cell); // ✅ Use effective duration
            const endTime = startTime + effectiveDuration;

            // Handle floating-point precision issues with a small epsilon
            const epsilon = 0.001;
            const isAtStart = Math.abs(clampedTime - startTime) < epsilon;
            const isWithinClip = clampedTime >= startTime && clampedTime < endTime;

            if (isAtStart) {
                // At or very close to clip start time (handles floating-point precision)
                return {
                    clip: cell,
                    clipTime: 0,
                    clipIndex: i,
                    clipStartTime: startTime,
                    clipEndTime: endTime
                };
            } else if (isWithinClip) {
                // Normal case: time is strictly within clip boundaries
                const clipTime = clampedTime - startTime;

                return {
                    clip: cell,
                    clipTime,
                    clipIndex: i,
                    clipStartTime: startTime,
                    clipEndTime: endTime
                };
            }
        }

        // Special case: if we're at the very end of timeline, return the last clip at its final frame
        if (clampedTime >= this.totalDuration && this.cells.length > 0) {
            const lastClip = this.cells[this.cells.length - 1];
            const lastClipStartTime = lastClip.startTime || 0;
            const lastClipDuration = this.getEffectiveDuration(lastClip); // ✅ Use effective duration

            return {
                clip: lastClip,
                clipTime: lastClipDuration, // At the very end of the last clip
                clipIndex: this.cells.length - 1,
                clipStartTime: lastClipStartTime,
                clipEndTime: lastClipStartTime + lastClipDuration
            };
        }

        // If no clip found, return null (timeline gap)
        return null;
    }

    clipPositionToGlobalTime(clipIndex: number, clipTime: number): number {
        if (clipIndex < 0 || clipIndex >= this.cells.length) {
            return 0;
        }

        const cell = this.cells[clipIndex];
        const startTime = cell.startTime || 0;
        const effectiveDuration = this.getEffectiveDuration(cell); // ✅ Use effective duration

        // Clamp clip time to valid range within this clip
        const clampedClipTime = Math.max(0, Math.min(clipTime, effectiveDuration));

        return startTime + clampedClipTime;
    }

    // Timeline state management
    getCurrentTime(): number {
        return this.currentTime;
    }

    setCurrentTime(globalTime: number): void {
        const clampedTime = Math.max(0, Math.min(globalTime, this.totalDuration));

        if (this.currentTime !== clampedTime) {
            this.updateCurrentTimeInternal(clampedTime, true); // External update - notify all subscribers

            // CRITICAL FIX: If we're playing, restart the master clock with fresh timing
            // This prevents the master clock from using stale frame timestamps after manual seeking
            if (this.playing) {
                this.startMasterClock(); // This will reset lastFrameTime and restart the loop
            }
        }
    }

    getTotalDuration(): number {
        return this.totalDuration;
    }

    updateTimeline(cells: SceneEditorCell[]): void {
        this.cells = [...cells].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

        // Recalculate total duration
        this.totalDuration = this.calculateTotalDuration();

        // Adjust current time if it's beyond the new timeline
        if (this.currentTime > this.totalDuration) {
            this.setCurrentTime(this.totalDuration);
        }

        // Notify subscribers of timeline change
        this.notifyTimelineChange();
        this.notifyVideoPlayerInstruction();
    }

    // Integration with existing zoom system
    getPlayheadPixelPosition(globalTime: number): number {
        return this.zoomSystem.getPixelFromTime(globalTime);
    }

    getTimeFromPixelClick(pixelX: number): number {
        return this.zoomSystem.getTimeFromPixel(pixelX);
    }

    updateZoomSystem(newZoomSystem: ZoomSystem): void {
        console.log('🔍 VTM: Updating zoom system to', newZoomSystem.level, 'at', newZoomSystem.pixelsPerSecond, 'px/s');
        this.zoomSystem = newZoomSystem;

        // Notify subscribers that the timeline may have changed dimensions
        // This ensures components update their visual positioning
        this.notifyTimelineChange();
        this.notifyCurrentTimeChange(this.currentTime);
    }

    // Playback state
    setPlaying(isPlaying: boolean): void {
        if (this.playing !== isPlaying) {
            this.playing = isPlaying;

            if (isPlaying) {
                // If we're at the end of timeline and user clicks play, restart from beginning
                if (this.currentTime >= this.totalDuration) {
                    this.setCurrentTime(0);
                }
                this.startMasterClock();
            } else {
                this.stopMasterClock();
            }

            this.notifyTimelineChange();
        }
    }

    isPlaying(): boolean {
        return this.playing;
    }

    // Master Clock Control (NEW)
    startMasterClock(): void {
        if (this.masterClockRef !== null) {
            this.stopMasterClock(); // Clean up existing clock
        }

        // Reset frame time to avoid large delta on first frame after seeking
        this.lastFrameTime = performance.now();
        this.masterClockRef = requestAnimationFrame(this.masterClockLoop);
    }

    stopMasterClock(): void {
        if (this.masterClockRef !== null) {
            cancelAnimationFrame(this.masterClockRef);
            this.masterClockRef = null;
        }
    }

    // Event system for component synchronization
    onTimelineChange(callback: TimelineChangeCallback): () => void {
        this.timelineChangeCallbacks.push(callback);

        // Return unsubscribe function
        return () => {
            const index = this.timelineChangeCallbacks.indexOf(callback);
            if (index > -1) {
                this.timelineChangeCallbacks.splice(index, 1);
            }
        };
    }

    onCurrentTimeChange(callback: CurrentTimeChangeCallback): () => void {
        this.currentTimeChangeCallbacks.push(callback);

        return () => {
            const index = this.currentTimeChangeCallbacks.indexOf(callback);
            if (index > -1) {
                this.currentTimeChangeCallbacks.splice(index, 1);
            }
        };
    }

    onVideoPlayerInstruction(callback: VideoPlayerCallback): () => void {
        this.videoPlayerCallbacks.push(callback);

        return () => {
            const index = this.videoPlayerCallbacks.indexOf(callback);
            if (index > -1) {
                this.videoPlayerCallbacks.splice(index, 1);
            }
        };
    }

    // Utility methods
    getCurrentClip(): ClipPosition | null {
        return this.globalTimeToClipPosition(this.currentTime);
    }

    getTimelineState(): TimelineState {
        return {
            totalDuration: this.totalDuration,
            currentTime: this.currentTime,
            currentClip: this.getCurrentClip(),
            isPlaying: this.playing
        };
    }

    validateTimelineIntegrity(): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        // Check for overlapping clips using effective duration (accounting for trimming)
        for (let i = 0; i < this.cells.length - 1; i++) {
            const current = this.cells[i];
            const next = this.cells[i + 1];

            const currentEnd = (current.startTime || 0) + this.getEffectiveDuration(current); // ✅ Use effective duration
            const nextStart = next.startTime || 0;

            if (currentEnd > nextStart) {
                errors.push(`Clip ${current.id} overlaps with ${next.id}`);
            }
        }

        // Check for negative effective durations
        this.cells.forEach(cell => {
            const effectiveDuration = this.getEffectiveDuration(cell);
            if (effectiveDuration < 0) {
                errors.push(`Clip ${cell.id} has negative effective duration: ${effectiveDuration}s`);
            }
        });

        // Check for invalid start times
        this.cells.forEach(cell => {
            if (cell.startTime !== undefined && cell.startTime < 0) {
                errors.push(`Clip ${cell.id} has negative start time`);
            }
        });

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    // Private helper methods

    /**
     * Calculate effective duration of a cell after trimming
     * This is the visible duration that should be used for timeline calculations
     */
    private getEffectiveDuration(cell: SceneEditorCell): number {
        const originalDuration = Number.isFinite(cell.duration) ? cell.duration! : 0;
        const trimStart = cell.trimStart || 0;
        const trimEnd = cell.trimEnd || 0;
        return Math.max(0.1, originalDuration - trimStart - trimEnd);
    }

    private calculateTotalDuration(): number {
        if (this.cells.length === 0) return 0;

        // Find the latest end time using effective duration (accounting for trimming)
        let maxEndTime = 0;
        this.cells.forEach(cell => {
            const startTime = cell.startTime || 0;
            const effectiveDuration = this.getEffectiveDuration(cell); // ✅ Use effective duration
            const endTime = startTime + effectiveDuration;
            maxEndTime = Math.max(maxEndTime, endTime);
        });

        return maxEndTime;
    }

    // Master Clock Loop (NEW)
    private masterClockLoop = (): void => {
        if (!this.playing) {
            this.masterClockRef = null;
            return;
        }

        const now = performance.now();
        const deltaTime = (now - this.lastFrameTime) / 1000; // Convert to seconds

        // Sanity check: ignore huge time jumps (first frame after seeking/pause) or negative deltas
        if (deltaTime > 0 && deltaTime < 0.1) {
            const newTime = this.currentTime + deltaTime;

            // Check if we've reached the end of timeline
            if (newTime >= this.totalDuration) {
                this.updateCurrentTimeInternal(this.totalDuration, false);
                this.setPlaying(false); // This will stop the master clock
                return;
            }

            this.updateCurrentTimeInternal(newTime, false); // Internal update - no external interference
        }

        this.lastFrameTime = now;
        this.masterClockRef = requestAnimationFrame(this.masterClockLoop);
    };

    // Internal time update method - separates external vs internal time changes
    private updateCurrentTimeInternal(newTime: number, notifyAll: boolean): void {
        const clampedTime = Math.max(0, Math.min(newTime, this.totalDuration));

        if (this.currentTime !== clampedTime) {
            this.currentTime = clampedTime;

            // Always notify time change subscribers (for playhead updates)
            this.notifyCurrentTimeChange(clampedTime);

            if (notifyAll) {
                // Full notification for external changes (user seeking, etc.)
                this.notifyTimelineChange();
                this.notifyVideoPlayerInstruction();
            } else {
                // Lightweight notification for master clock updates - only update video player
                this.notifyVideoPlayerInstruction();
            }
        }
    }

    private notifyTimelineChange(): void {
        const state = this.getTimelineState();
        this.timelineChangeCallbacks.forEach(callback => {
            try {
                callback(state);
            } catch (error) {
                console.error('Error in timeline change callback:', error);
            }
        });
    }

    private notifyCurrentTimeChange(globalTime: number): void {
        this.currentTimeChangeCallbacks.forEach(callback => {
            try {
                callback(globalTime);
            } catch (error) {
                console.error('Error in current time change callback:', error);
            }
        });
    }

    private notifyVideoPlayerInstruction(): void {
        const clipPosition = this.getCurrentClip();

        const instruction: VideoPlayerInstruction = {
            clip: clipPosition?.clip || null,
            seekTime: clipPosition?.clipTime || 0
        };

        console.log('📺 VTM notifyVideoPlayerInstruction:', {
            currentTime: this.currentTime,
            clipPosition,
            instruction,
            cellsCount: this.cells.length,
            cells: this.cells.map(c => ({
                id: c.id,
                mediaNodeId: c.mediaNodeId,
                startTime: c.startTime,
                duration: c.duration,
                position: c.position
            }))
        });

        this.videoPlayerCallbacks.forEach(callback => {
            try {
                callback(instruction);
            } catch (error) {
                console.error('Error in video player callback:', error);
            }
        });
    }

    // Drag operation support
    validateClipMove(clipId: string, newStartTime: number): {
        valid: boolean;
        suggestedTime?: number;
        conflicts?: string[];
    } {
        const conflicts: string[] = [];
        const movingClip = this.cells.find(cell => cell.id === clipId);

        if (!movingClip) {
            return { valid: false, conflicts: ['Clip not found'] };
        }

        if (newStartTime < 0) {
            return {
                valid: false,
                suggestedTime: 0,
                conflicts: ['Start time cannot be negative']
            };
        }

        const clipEffectiveDuration = this.getEffectiveDuration(movingClip); // ✅ Use effective duration
        const newEndTime = newStartTime + clipEffectiveDuration;

        // Check for overlaps with other clips
        const otherClips = this.cells.filter(cell => cell.id !== clipId);
        let hasConflict = false;
        let suggestedTime = newStartTime;

        for (const otherClip of otherClips) {
            const otherStart = otherClip.startTime || 0;
            const otherEffectiveDuration = this.getEffectiveDuration(otherClip); // ✅ Use effective duration
            const otherEnd = otherStart + otherEffectiveDuration;

            // Check if there's an overlap
            const overlapsStart = newStartTime < otherEnd && newEndTime > otherStart;
            if (overlapsStart) {
                hasConflict = true;
                conflicts.push(`Would overlap with clip ${otherClip.id}`);

                // Suggest placement after the conflicting clip
                suggestedTime = Math.max(suggestedTime, otherEnd);
            }
        }

        return {
            valid: !hasConflict,
            suggestedTime: hasConflict ? suggestedTime : undefined,
            conflicts: conflicts.length > 0 ? conflicts : undefined
        };
    }

    adjustPlayheadAfterClipMove(clipId: string, oldStartTime: number, newStartTime: number): void {
        const currentTime = this.getCurrentTime();
        const movedClip = this.cells.find(cell => cell.id === clipId);

        if (!movedClip) return;

        const clipEffectiveDuration = this.getEffectiveDuration(movedClip); // ✅ Use effective duration
        const oldEndTime = oldStartTime + clipEffectiveDuration;
        const newEndTime = newStartTime + clipEffectiveDuration;

        // Check if playhead was within the moved clip
        if (currentTime >= oldStartTime && currentTime <= oldEndTime) {
            // Calculate relative position within the clip
            const relativeTime = currentTime - oldStartTime;
            const newPlayheadTime = newStartTime + relativeTime;

            console.log('🎯 Adjusting playhead after clip move:', {
                oldTime: currentTime,
                newTime: newPlayheadTime,
                clipMove: `${oldStartTime}s -> ${newStartTime}s`
            });

            this.setCurrentTime(newPlayheadTime);
        }
        // If playhead was after the moved clip and the clip moved earlier,
        // we might want to adjust, but for now keep it simple
    }

    // Enhanced timeline update with playhead adjustment support
    updateTimelineAfterDrag(cells: SceneEditorCell[], draggedClipId?: string, oldStartTime?: number, newStartTime?: number): void {
        this.updateTimeline(cells);

        // Adjust playhead if a specific clip was dragged
        if (draggedClipId && oldStartTime !== undefined && newStartTime !== undefined) {
            this.adjustPlayheadAfterClipMove(draggedClipId, oldStartTime, newStartTime);
        }
    }
}

/**
 * Factory function to create VirtualTimelineManager instance
 */
export const createVirtualTimelineManager = (
    zoomSystem: ZoomSystem,
    initialCells: SceneEditorCell[] = []
): VirtualTimelineManager => {
    return new VirtualTimelineManagerImpl(zoomSystem, initialCells);
}; 