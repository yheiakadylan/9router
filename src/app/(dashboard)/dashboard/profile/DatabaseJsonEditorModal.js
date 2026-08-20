"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import Modal from "@/shared/components/Modal";

export default function DatabaseJsonEditorModal({ initialJson, password, onClose, onSaved }) {
  const [jsonText, setJsonText] = useState(initialJson);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState({ type: "", message: "" });

  const formatJson = () => {
    try {
      setJsonText(JSON.stringify(JSON.parse(jsonText), null, 2));
      setStatus({ type: "success", message: "JSON is valid" });
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    }
  };

  const reloadDatabase = async () => {
    setLoading(true);
    setStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings/database", {
        headers: { "x-9r-password": password },
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to reload database");
      setJsonText(JSON.stringify(data, null, 2));
      setStatus({ type: "success", message: "Reloaded current database" });
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setLoading(false);
    }
  };

  const saveDatabase = async () => {
    let database;
    try {
      database = JSON.parse(jsonText);
    } catch (error) {
      setStatus({ type: "error", message: error.message });
      return;
    }
    if (!window.confirm("Replace the current database with this JSON? A safety backup will be created first.")) return;

    setLoading(true);
    setStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, database }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save database");
      setStatus({ type: "success", message: "Database saved. Safety backup created." });
      onSaved();
    } catch (error) {
      setStatus({ type: "error", message: error.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Edit Database JSON"
      size="full"
      closeOnOverlay={false}
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={loading}>Close</Button>
          <Button variant="outline" icon="refresh" onClick={reloadDatabase} disabled={loading}>Reload</Button>
          <Button variant="secondary" icon="data_object" onClick={formatJson} disabled={loading}>Format & Validate</Button>
          <Button variant="primary" icon="save" onClick={saveDatabase} loading={loading}>Save Database</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          This JSON contains API keys and OAuth tokens. Do not share it. Saving replaces the current configuration database, but keeps usage history and request logs.
        </div>
        <textarea
          value={jsonText}
          onChange={(event) => setJsonText(event.target.value)}
          className="min-h-[55vh] w-full resize-y rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-relaxed text-text-main outline-none focus:border-primary"
          spellCheck={false}
          aria-label="Database JSON"
        />
        {status.message ? (
          <p className={`text-sm ${status.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
            {status.message}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

DatabaseJsonEditorModal.propTypes = {
  initialJson: PropTypes.string.isRequired,
  password: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
};
