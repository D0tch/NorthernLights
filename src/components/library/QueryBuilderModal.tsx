import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2 } from 'lucide-react';
import {
  ARTIST_QUERY_METADATA_TYPES,
  ALBUM_QUERY_METADATA_TYPES,
  QueryGroup,
  QueryCondition,
  createGroupId,
} from '../../utils/filterState';
import { usePlayerStore } from '../../store/index';

interface QueryBuilderModalProps {
  view: 'artists' | 'albums';
  isOpen: boolean;
  onClose: () => void;
  onApply: (groups: QueryGroup[]) => void;
  initialGroups: QueryGroup[] | null;
}

const EMPTY_CONDITION: QueryCondition = {
  metadataType: '',
  operator: '',
  value: '',
};

export const QueryBuilderModal: React.FC<QueryBuilderModalProps> = ({
  view,
  isOpen,
  onClose,
  onApply,
  initialGroups,
}) => {
  const [groups, setGroups] = useState<QueryGroup[]>(
    initialGroups && initialGroups.length > 0
      ? initialGroups
      : [{ id: createGroupId(), conditions: [{ ...EMPTY_CONDITION }] }]
  );
  const modalRef = useRef<HTMLDivElement>(null);

  const metadataTypes = view === 'artists' ? ARTIST_QUERY_METADATA_TYPES : ALBUM_QUERY_METADATA_TYPES;

  useEffect(() => {
    if (isOpen) {
      setGroups(
        initialGroups && initialGroups.length > 0
          ? initialGroups
          : [{ id: createGroupId(), conditions: [{ ...EMPTY_CONDITION }] }]
      );
    }
  }, [isOpen, initialGroups]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [isOpen]);

  const updateCondition = useCallback((groupId: string, condIdx: number, updates: Partial<QueryCondition>) => {
    setGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      const newConditions = g.conditions.map((c, i) => {
        if (i !== condIdx) return c;
        const next = { ...c, ...updates };
        if (updates.metadataType !== undefined && updates.metadataType !== c.metadataType) {
          next.operator = '';
          next.value = '';
        }
        return next;
      });
      return { ...g, conditions: newConditions };
    }));
  }, []);

  const addCondition = useCallback((groupId: string) => {
    setGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      return { ...g, conditions: [...g.conditions, { ...EMPTY_CONDITION }] };
    }));
  }, []);

  const removeCondition = useCallback((groupId: string, condIdx: number) => {
    setGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      const newConditions = g.conditions.filter((_, i) => i !== condIdx);
      if (newConditions.length === 0) return { ...g, conditions: [{ ...EMPTY_CONDITION }] };
      return { ...g, conditions: newConditions };
    }));
  }, []);

  const addGroup = useCallback(() => {
    setGroups(prev => [...prev, { id: createGroupId(), conditions: [{ ...EMPTY_CONDITION }] }]);
  }, []);

  const removeGroup = useCallback((groupId: string) => {
    setGroups(prev => {
      const next = prev.filter(g => g.id !== groupId);
      if (next.length === 0) return [{ id: createGroupId(), conditions: [{ ...EMPTY_CONDITION }] }];
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    const cleaned = groups.map(g => ({
      ...g,
      conditions: g.conditions.filter(c => c.metadataType && c.operator && (c.value || c.metadataType === 'image_url')),
    })).filter(g => g.conditions.length > 0);
    onApply(cleaned);
    onClose();
  }, [groups, onApply, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        ref={modalRef}
        className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-[var(--color-background)] border border-[var(--glass-border)] rounded-2xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-[var(--glass-border)]">
          <div>
            <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Build query</h2>
            <p className="text-sm text-[var(--color-text-muted)] mt-0.5">
              {view === 'artists' ? 'Artists' : 'Albums'} matching all groups
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors p-1 rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {groups.map((group, gIdx) => (
            <div key={group.id} className="space-y-2">
              {gIdx > 0 && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 h-px bg-[var(--glass-border)]" />
                  <span className="text-xs font-semibold text-[var(--color-primary)] uppercase tracking-wider">and</span>
                  <div className="flex-1 h-px bg-[var(--glass-border)]" />
                </div>
              )}
              <div className="rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface-variant)]/30 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    Group {gIdx + 1}
                  </span>
                  {groups.length > 1 && (
                    <button
                      onClick={() => removeGroup(group.id)}
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors p-1 rounded focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
                      aria-label="Remove group"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                {group.conditions.map((cond, cIdx) => (
                  <ConditionRow
                    key={cIdx}
                    condition={cond}
                    metadataTypes={metadataTypes}
                    onChange={(updates) => updateCondition(group.id, cIdx, updates)}
                    onRemove={() => removeCondition(group.id, cIdx)}
                    canRemove={group.conditions.length > 1}
                    showOr={cIdx > 0}
                  />
                ))}
                <button
                  onClick={() => addCondition(group.id)}
                  className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-colors py-1"
                >
                  <Plus size={12} />
                  Add condition
                </button>
              </div>
            </div>
          ))}
          <button
            onClick={addGroup}
            className="flex items-center gap-1.5 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-colors py-1"
          >
            <Plus size={14} />
            Add group
          </button>
        </div>

        <div className="flex items-center gap-3 p-5 border-t border-[var(--glass-border)]">
          <button onClick={handleApply} className="btn btn-primary flex-1">
            Apply
          </button>
          <button onClick={onClose} className="btn btn-ghost flex-1">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

const ConditionRow: React.FC<{
  condition: QueryCondition;
  metadataTypes: typeof ARTIST_QUERY_METADATA_TYPES;
  onChange: (updates: Partial<QueryCondition>) => void;
  onRemove: () => void;
  canRemove: boolean;
  showOr: boolean;
}> = ({ condition, metadataTypes, onChange, onRemove, canRemove, showOr }) => {
  const selectedMeta = metadataTypes.find(m => m.key === condition.metadataType);
  const operators = selectedMeta?.operators || [];

  const isBoolean = condition.metadataType === 'image_url' &&
    (condition.operator === 'is' || condition.operator === 'is not');

  return (
    <div className="flex items-center gap-2">
      {showOr && (
        <span className="text-xs font-semibold text-[var(--color-text-muted)] w-6 text-center">or</span>
      )}
      {!showOr && <span className="w-6" />}
      <select
        value={condition.metadataType}
        onChange={e => onChange({ metadataType: e.target.value })}
        className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)] text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
        aria-label="Metadata type"
      >
        <option value="">Select field</option>
        {metadataTypes.map(m => (
          <option key={m.key} value={m.key}>{m.label}</option>
        ))}
      </select>
      <select
        value={condition.operator}
        onChange={e => onChange({ operator: e.target.value })}
        disabled={!condition.metadataType}
        className="w-28 px-2.5 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)] text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
        aria-label="Operator"
      >
        <option value="">Operator</option>
        {operators.map(o => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      {!isBoolean && (
        <input
          type="text"
          value={condition.value}
          onChange={e => onChange({ value: e.target.value })}
          disabled={!condition.operator}
          placeholder="Value"
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)] text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
          aria-label="Value"
        />
      )}
      {canRemove && (
        <button
          onClick={onRemove}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors p-1 rounded focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
          aria-label="Remove condition"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
};
