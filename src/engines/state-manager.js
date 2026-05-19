import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { logger } from '../logging/logger.js';
import path from 'path';

export class StateManager {
  constructor(stateFilePath) {
    this.stateFilePath = path.resolve(stateFilePath);
    this.tempFilePath = this.stateFilePath + '.tmp';
  }

  loadState(defaultState = {}) {
    try {
      if (!existsSync(this.stateFilePath)) {
        logger.info('[state] State file not found, creating with defaults: ' + this.stateFilePath);
        this.saveState(defaultState);
        return defaultState;
      }

      const stateText = readFileSync(this.stateFilePath, 'utf-8');
      const state = JSON.parse(stateText);
      logger.info('[state] Loaded state from: ' + this.stateFilePath);
      return state;
    } catch (error) {
      logger.error('[state] Error loading state: ' + error.message + ', using defaults');
      return defaultState;
    }
  }

  saveState(state) {
    try {
      mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      // Atomic write: write to temp file first, then rename
      writeFileSync(this.tempFilePath, JSON.stringify(state, null, 2), 'utf-8');
      renameSync(this.tempFilePath, this.stateFilePath);
      logger.debug('[state] State saved atomically to: ' + this.stateFilePath);
    } catch (error) {
      logger.error('[state] Error saving state: ' + error.message);
      throw error;
    }
  }
}

// Convert Map to Object and vice versa for JSON serialization
export function serializeState(state) {
  return {
    ...state,
    positions: state.positions ? Object.fromEntries(state.positions) : {}
  };
}

export function deserializeState(serializedState) {
  const positions = Array.isArray(serializedState.positions)
    ? new Map(serializedState.positions)
    : new Map(Object.entries(serializedState.positions || {}));
  const state = {
    ...serializedState,
    positions
  };
  state.openPositions = positions.size;
  state.totalExposure = [...positions.values()].reduce((sum, pos) => sum + (Number(pos?.stakeUsed) || 0), 0);
  return state;
}
