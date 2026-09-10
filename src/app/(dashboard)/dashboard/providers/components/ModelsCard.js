"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, rectSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, Button, Modal } from "@/shared/components";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { getProviderAlias } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// ── Sortable Wrapper ──────────────────────────────────────────
function SortableModelCard({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style}>
      {children({ attributes, listeners })}
    </div>
  );
}

// ── ModelRow ───────────────────────────────────────────────────
export function ModelRow({ model, fullModel, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, dragHandleProps }) {
  const borderColor = testStatus === "ok" ? "border-green-500/40" : testStatus === "error" ? "border-red-500/40" : "border-border";
  const iconColor = testStatus === "ok" ? "#22c55e" : testStatus === "error" ? "#ef4444" : undefined;

  return (
    <div className={`group px-3 py-2 rounded-lg border ${borderColor} hover:bg-sidebar/50`}>
      <div className="flex items-center gap-2">
        {dragHandleProps && (
          <button
            {...dragHandleProps}
            type="button"
            title="Drag to reorder"
            className="cursor-grab active:cursor-grabbing p-0.5 -ml-1 text-text-muted/40 hover:text-primary transition-colors shrink-0"
          >
            <span className="material-symbols-outlined text-[15px] select-none">drag_indicator</span>
          </button>
        )}
        <span className="material-symbols-outlined text-base" style={iconColor ? { color: iconColor } : undefined}>
          {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
        </span>
        <div className="flex flex-col gap-1">
          <code className="text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">{fullModel}</code>
          {model.name && <span className="text-[9px] text-text-muted/70 italic pl-1">{model.name}</span>}
        </div>
        {onTest && (
          <div className="relative group/btn">
            <button onClick={onTest} disabled={isTesting} className={`p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary transition-opacity ${isTesting ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
              <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                {isTesting ? "progress_activity" : "science"}
              </span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {isTesting ? "Testing..." : "Test"}
            </span>
          </div>
        )}
        <div className="relative group/btn">
          <button onClick={() => onCopy(fullModel, `model-${model.id}`)} className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary">
            <span className="material-symbols-outlined text-sm">{copied === `model-${model.id}` ? "check" : "content_copy"}</span>
          </button>
          <span className="pointer-events-none absolute mt-1 top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
            {copied === `model-${model.id}` ? "Copied!" : "Copy"}
          </span>
        </div>
        {isFree && <span className="text-[10px] font-bold text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded">FREE</span>}
        {isCustom ? (
          <button onClick={onDeleteAlias} className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity ml-auto" title="Remove custom model">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        ) : onDisable ? (
          <button onClick={onDisable} className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 opacity-100 transition-opacity ml-auto sm:opacity-0 sm:group-hover:opacity-100" title="Disable this model">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({ id: PropTypes.string.isRequired }).isRequired,
  fullModel: PropTypes.string.isRequired,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  dragHandleProps: PropTypes.object,
};

// ── AddCustomModelModal ────────────────────────────────────────
function AddCustomModelModal({ isOpen, onSave, onClose }) {
  const [modelId, setModelId] = useState("");

  const handleSave = () => {
    if (!modelId.trim()) return;
    onSave(modelId.trim());
    setModelId("");
  };

  return (
    <Modal isOpen={isOpen} title="Add Custom Model" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            placeholder="e.g. tts-1-hd"
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSave} fullWidth disabled={!modelId.trim()}>Add</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

AddCustomModelModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

// ── ModelsCard ─────────────────────────────────────────────────
// Self-contained card: shows models for a provider, filtered by optional `kindFilter`.
// kindFilter: if provided, only shows models with matching type/kinds field.
export default function ModelsCard({ providerId, kindFilter, providerAliasOverride }) {
  const { copied, copy } = useCopyToClipboard();
  const [modelAliases, setModelAliases] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [modelTestResults, setModelTestResults] = useState({});
  const [testingModelId, setTestingModelId] = useState(null);
  const [testError, setTestError] = useState("");
  const [showAddCustomModel, setShowAddCustomModel] = useState(false);
  const [disabledModelIds, setDisabledModelIds] = useState([]);
  const [modelOrder, setModelOrder] = useState([]);

  const providerAlias = providerAliasOverride || getProviderAlias(providerId);
  const effectiveType = kindFilter || "llm";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const fetchData = useCallback(async () => {
    try {
      const [aliasRes, customRes, disabledRes, orderRes] = await Promise.all([
        fetch("/api/models/alias"),
        fetch("/api/models/custom", { cache: "no-store" }),
        fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(providerAlias)}`, { cache: "no-store" }),
        fetch(`/api/models/order?providerAlias=${encodeURIComponent(providerAlias)}&kind=${encodeURIComponent(effectiveType)}`, { cache: "no-store" }),
      ]);
      const aliasData = await aliasRes.json();
      const customData = await customRes.json();
      const disabledData = await disabledRes.json();
      const orderData = orderRes.ok ? await orderRes.json() : {};
      if (aliasRes.ok) setModelAliases(aliasData.aliases || {});
      if (customRes.ok) setCustomModels(customData.models || []);
      if (disabledRes.ok) setDisabledModelIds(disabledData.ids || []);
      if (orderRes.ok && Array.isArray(orderData.order)) setModelOrder(orderData.order);
    } catch (e) { console.log("ModelsCard fetch error:", e); }
  }, [providerAlias, effectiveType]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSetAlias = async (modelId, alias) => {
    const fullModel = `${providerAlias}/${modelId}`;
    try {
      const res = await fetch("/api/models/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: fullModel, alias }),
      });
      if (res.ok) await fetchData();
    } catch (e) { console.log("set alias error:", e); }
  };

  const handleDeleteAlias = async (alias) => {
    try {
      const res = await fetch(`/api/models/alias?alias=${encodeURIComponent(alias)}`, { method: "DELETE" });
      if (res.ok) await fetchData();
    } catch (e) { console.log("delete alias error:", e); }
  };

  const handleAddCustomModel = async (modelId) => {
    try {
      const res = await fetch("/api/models/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias, id: modelId, type: effectiveType }),
      });
      if (res.ok) {
        await fetchData();
        window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch (e) { console.log("add custom model error:", e); }
  };

  const handleDeleteCustomModel = async (modelId) => {
    try {
      const params = new URLSearchParams({ providerAlias, id: modelId, type: effectiveType });
      const res = await fetch(`/api/models/custom?${params}`, { method: "DELETE" });
      if (res.ok) {
        await fetchData();
        window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch (e) { console.log("delete custom model error:", e); }
  };

  const handleDisableModel = async (modelId) => {
    try {
      const res = await fetch("/api/models/disabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias, ids: [modelId] }),
      });
      if (res.ok) await fetchData();
    } catch (e) { console.log("disable model error:", e); }
  };

  const handleEnableModel = async (modelId) => {
    try {
      const params = new URLSearchParams({ providerAlias, id: modelId });
      const res = await fetch(`/api/models/disabled?${params}`, { method: "DELETE" });
      if (res.ok) await fetchData();
    } catch (e) { console.log("enable model error:", e); }
  };

  const handleTestModel = async (modelId) => {
    if (testingModelId) return;
    setTestingModelId(modelId);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerAlias}/${modelId}`, kind: kindFilter }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
      setTestError(data.ok ? "" : (data.error || "Model not reachable"));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
      setTestError("Network error");
    } finally { setTestingModelId(null); }
  };

  // Built-in models — filter by kindFilter if provided
  const allBuiltIn = getModelsByProviderId(providerId);
  const builtInModels = kindFilter
    ? allBuiltIn.filter((m) => {
        if (m.kinds) return m.kinds.includes(kindFilter);
        return getModelKind(m, "llm") === kindFilter;
      })
    : allBuiltIn;

  // Custom models for this provider + kind, dedupe vs built-in
  const myCustomModels = customModels.filter(
    (m) => m.providerAlias === providerAlias
      && getModelKind(m, "llm") === effectiveType
      && !builtInModels.some((b) => b.id === m.id)
  ).map((m) => ({ ...m, isCustom: true }));

  const disabledSet = new Set(disabledModelIds);
  const displayModels = builtInModels.filter((model) => !disabledSet.has(model.id));
  const disabledDisplayModels = builtInModels.filter((model) => disabledSet.has(model.id));

  // Combine and sort models according to modelOrder
  const sortedModels = useMemo(() => {
    const combined = [...displayModels, ...myCustomModels];
    if (!modelOrder.length) return combined;

    const orderMap = new Map();
    modelOrder.forEach((id, idx) => orderMap.set(id, idx));

    return [...combined].sort((a, b) => {
      const aIndex = orderMap.has(a.id) ? orderMap.get(a.id) : 9999;
      const bIndex = orderMap.has(b.id) ? orderMap.get(b.id) : 9999;
      if (aIndex !== bIndex) return aIndex - bIndex;
      return 0;
    });
  }, [displayModels, myCustomModels, modelOrder]);

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sortedModels.findIndex((m) => m.id === active.id);
    const newIndex = sortedModels.findIndex((m) => m.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const next = arrayMove(sortedModels, oldIndex, newIndex);
    const nextOrder = next.map((m) => m.id);
    setModelOrder(nextOrder);

    try {
      await fetch("/api/models/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerAlias,
          kind: effectiveType,
          order: nextOrder,
        }),
      });
      window.dispatchEvent(new CustomEvent("modelOrderChanged", {
        detail: { providerAlias, kind: effectiveType, order: nextOrder },
      }));
    } catch (err) {
      console.error("Failed to save model order:", err);
    }
  };

  const handleResetOrder = async () => {
    setModelOrder([]);
    try {
      await fetch(`/api/models/order?providerAlias=${encodeURIComponent(providerAlias)}&kind=${encodeURIComponent(effectiveType)}`, {
        method: "DELETE",
      });
      window.dispatchEvent(new CustomEvent("modelOrderChanged", {
        detail: { providerAlias, kind: effectiveType, order: [] },
      }));
    } catch (err) {
      console.error("Failed to reset model order:", err);
    }
  };

  return (
    <>
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Models{kindFilter ? ` — ${kindFilter.toUpperCase()}` : ""}</h2>
            <span className="text-xs text-text-muted">({sortedModels.length})</span>
          </div>
          {modelOrder.length > 0 && (
            <button
              type="button"
              onClick={handleResetOrder}
              className="text-xs text-text-muted hover:text-primary transition-colors flex items-center gap-1"
              title="Reset to default order"
            >
              <span className="material-symbols-outlined text-[14px]">restart_alt</span>
              Reset order
            </button>
          )}
        </div>
        {testError && <p className="text-xs text-red-500 mb-3 break-words">{testError}</p>}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sortedModels.map((m) => m.id)} strategy={rectSortingStrategy}>
            <div className="flex flex-wrap gap-3">
              {sortedModels.map((model) => {
                const fullModel = `${providerAlias}/${model.id}`;
                const isCustom = !!model.isCustom;
                const existingAlias = Object.entries(modelAliases).find(([, m]) => m === fullModel)?.[0];
                return (
                  <SortableModelCard key={model.id} id={model.id}>
                    {({ attributes, listeners }) => (
                      <ModelRow
                        model={model}
                        fullModel={fullModel}
                        alias={existingAlias}
                        copied={copied}
                        onCopy={copy}
                        onSetAlias={(alias) => handleSetAlias(model.id, alias)}
                        onDeleteAlias={isCustom ? () => handleDeleteCustomModel(model.id) : () => handleDeleteAlias(existingAlias)}
                        testStatus={modelTestResults[model.id]}
                        onTest={() => handleTestModel(model.id)}
                        isTesting={testingModelId === model.id}
                        isFree={model.isFree}
                        isCustom={isCustom}
                        onDisable={isCustom ? undefined : () => handleDisableModel(model.id)}
                        dragHandleProps={{ ...attributes, ...listeners }}
                      />
                    )}
                  </SortableModelCard>
                );
              })}

              <button
                onClick={() => setShowAddCustomModel(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-black/15 dark:border-white/15 text-xs text-text-muted hover:text-primary hover:border-primary/40 transition-colors"
              >
                <span className="material-symbols-outlined text-sm">add</span>
                Add Model
              </button>

              {disabledDisplayModels.length > 0 && (
                <div className="w-full mt-2">
                  <p className="text-xs text-text-muted mb-2">Disabled models ({disabledDisplayModels.length}):</p>
                  <div className="flex flex-wrap gap-2">
                    {disabledDisplayModels.map((model) => (
                      <button
                        key={model.id}
                        onClick={() => handleEnableModel(model.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-dashed border-black/10 dark:border-white/10 text-xs text-text-muted hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors"
                        title="Restore model"
                      >
                        <span className="material-symbols-outlined text-[13px]">add</span>
                        {model.id}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </SortableContext>
        </DndContext>
      </Card>

      <AddCustomModelModal
        isOpen={showAddCustomModel}
        onSave={async (modelId) => {
          await handleAddCustomModel(modelId);
          setShowAddCustomModel(false);
        }}
        onClose={() => setShowAddCustomModel(false)}
      />
    </>
  );
}

ModelsCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  kindFilter: PropTypes.string, // e.g. "tts", "embedding" — filters models shown
  providerAliasOverride: PropTypes.string, // override alias (e.g. for custom-embedding nodes using prefix)
};
