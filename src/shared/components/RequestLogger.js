"use client";

import { useState, useEffect, useMemo } from "react";
import Card from "./Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);

export default function RequestLogger() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchLogs();
  }, []);

  useEffect(() => {
    let interval;
    if (autoRefresh) {
      interval = setInterval(() => {
        fetchLogs(false);
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [autoRefresh]);

  const fetchLogs = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch("/api/usage/request-logs");
      if (res.ok) {
        const data = await res.json();
        setLogs(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      console.error("Failed to fetch logs:", error);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  // Compute aggregate summary metrics from latest logs
  const summary = useMemo(() => {
    let totalIn = 0;
    let totalOut = 0;
    let successCount = 0;
    let failedCount = 0;
    const ipMap = {};

    for (const log of logs) {
      if (typeof log !== "string") continue;
      const parts = log.split(" | ");
      if (parts.length < 7) continue;

      const time = parts[0];
      const inTok = parseInt(parts[4]) || 0;
      const outTok = parseInt(parts[5]) || 0;
      totalIn += inTok;
      totalOut += outTok;

      const status = (parts[6] || "").toLowerCase();
      if (status.includes("ok") || status === "200" || status.includes("success")) {
        successCount++;
      } else if (status.includes("failed") || status.includes("error") || status.startsWith("5") || status.startsWith("4")) {
        failedCount++;
      } else {
        successCount++;
      }

      let ip = (parts[7] || "127.0.0.1").replace("::1", "127.0.0.1").trim();
      let legacyTool = "";
      if (ip.includes(" ")) {
        const match = ip.match(/^(.*?)\s*\((.*?)\)$/);
        if (match) {
          ip = match[1];
          legacyTool = match[2];
        }
      }
      const device = parts[8] || (legacyTool ? legacyTool.toUpperCase() : "Client API");
      const location = parts[9] || (ip === "127.0.0.1" || ip === "localhost" ? "Máy nội bộ (Localhost)" : "Internet");

      if (!ipMap[ip]) {
        ipMap[ip] = {
          ip,
          location,
          devices: new Set(),
          count: 0,
          tokens: 0,
          lastSeen: time,
        };
      }
      ipMap[ip].devices.add(device);
      ipMap[ip].count++;
      ipMap[ip].tokens += inTok + outTok;
    }

    const totalRequests = logs.length;
    const successRate = totalRequests > 0 ? Math.round((successCount / totalRequests) * 100) : 100;

    const ipList = Object.values(ipMap)
      .map((item) => ({
        ...item,
        deviceLabel: Array.from(item.devices).join(", "),
        percentage: totalRequests > 0 ? Math.round((item.count / totalRequests) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      totalRequests,
      totalIn,
      totalOut,
      successRate: `${successRate}%`,
      ipList,
    };
  }, [logs]);

  // Filter logs by search keyword
  const filteredLogs = useMemo(() => {
    if (!search.trim()) return logs;
    const q = search.toLowerCase();
    return logs.filter((log) => typeof log === "string" && log.toLowerCase().includes(q));
  }, [logs, search]);

  const toggleIpFilter = (ip) => {
    if (search === ip) {
      setSearch("");
    } else {
      setSearch(ip);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Overview Stat Cards */}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card padding="sm" className="flex flex-col justify-between gap-1">
          <span className="text-text-muted text-xs uppercase font-semibold">Tổng Request Gần Đây</span>
          <span className="text-2xl font-bold text-primary">{fmt(summary.totalRequests)}</span>
          <span className="text-[11px] text-text-muted truncate">lượt truy vấn ghi nhận</span>
        </Card>

        <Card padding="sm" className="flex flex-col justify-between gap-1">
          <span className="text-text-muted text-xs uppercase font-semibold">Số IP Đã Kết Nối</span>
          <span className="text-2xl font-bold text-info">{summary.ipList.length}</span>
          <span className="text-[11px] text-text-muted">địa chỉ IP khác nhau</span>
        </Card>

        <Card padding="sm" className="flex flex-col justify-between gap-1">
          <span className="text-text-muted text-xs uppercase font-semibold">Tổng Token Gần Đây</span>
          <span className="text-2xl font-bold text-warning">{fmt(summary.totalIn + summary.totalOut)}</span>
          <span className="text-[11px] text-text-muted truncate">
            In: {fmt(summary.totalIn)} · Out: {fmt(summary.totalOut)}
          </span>
        </Card>

        <Card padding="sm" className="flex flex-col justify-between gap-1">
          <span className="text-text-muted text-xs uppercase font-semibold">Tỉ Lệ Thành Công</span>
          <span className="text-2xl font-bold text-success">{summary.successRate}</span>
          <span className="text-[11px] text-text-muted">trạng thái phản hồi</span>
        </Card>
      </div>

      {/* List các địa chỉ IP request */}
      <Card padding="sm" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-text-main">Danh Sách Địa Chỉ IP Gửi Request</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-bold">
              {summary.ipList.length} IP
            </span>
          </div>
          {search && (
            <button
              onClick={() => setSearch("")}
              className="text-xs text-primary hover:underline font-medium"
            >
              Xóa bộ lọc IP ({search})
            </button>
          )}
        </div>

        {summary.ipList.length === 0 ? (
          <div className="text-xs text-text-muted italic py-2">Chưa ghi nhận IP nào.</div>
        ) : (
          <div className="overflow-x-auto max-h-56 overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-bg-subtle border-b border-border z-10 font-semibold text-text-muted">
                <tr>
                  <th className="px-3 py-2">Địa chỉ IP</th>
                  <th className="px-3 py-2">Vị trí</th>
                  <th className="px-3 py-2">Thiết bị / Ứng dụng</th>
                  <th className="px-3 py-2 text-right">Số Request</th>
                  <th className="px-3 py-2 text-right">Tổng Token</th>
                  <th className="px-3 py-2 text-right">Lần cuối</th>
                  <th className="px-3 py-2 text-center">Hành động</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {summary.ipList.map((item) => {
                  const isFiltered = search === item.ip;
                  return (
                    <tr
                      key={item.ip}
                      className={`hover:bg-primary/5 transition-colors ${isFiltered ? "bg-primary/10 font-medium" : ""}`}
                    >
                      <td className="px-3 py-2 font-mono font-bold text-text-main">
                        <span className="px-1.5 py-0.5 rounded bg-bg-subtle border border-border">
                          {item.ip}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-text-main">{item.location}</td>
                      <td className="px-3 py-2 text-text-main font-medium">{item.deviceLabel}</td>
                      <td className="px-3 py-2 text-right font-semibold text-primary">
                        {fmt(item.count)}{" "}
                        <span className="text-[10px] text-text-muted font-normal">
                          ({item.percentage}%)
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-warning">
                        {fmt(item.tokens)}
                      </td>
                      <td className="px-3 py-2 text-right text-text-muted whitespace-nowrap">
                        {item.lastSeen}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => toggleIpFilter(item.ip)}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                            isFiltered
                              ? "bg-primary text-white"
                              : "bg-surface hover:bg-primary/10 text-primary border border-primary/20"
                          }`}
                        >
                          {isFiltered ? "Bỏ lọc" : "Lọc logs"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Header bar: Title, Search filter, Auto Refresh */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Nhật Ký Request Thời Gian Thực</h2>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Lọc theo IP, thiết bị, model, status..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 px-3 text-xs rounded-lg border border-border bg-surface text-text-main focus:outline-none focus:ring-1 focus:ring-primary w-48 sm:w-64"
          />
          <label className="text-xs font-medium text-text-muted flex items-center gap-2 cursor-pointer whitespace-nowrap">
            <span>Tự làm mới (3s)</span>
            <div
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${autoRefresh ? "bg-primary" : "bg-bg-subtle border border-border"
                }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${autoRefresh ? "translate-x-5" : "translate-x-1"
                  }`}
              />
            </div>
          </label>
        </div>
      </div>

      <Card className="overflow-hidden bg-black/5 dark:bg-black/20">
        <div className="p-0 overflow-x-auto max-h-[600px] overflow-y-auto font-mono text-xs">
          {loading && logs.length === 0 ? (
            <div className="p-8 text-center text-text-muted">Loading logs...</div>
          ) : filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-text-muted">
              {logs.length === 0 ? "Chưa có log request nào được ghi nhận." : "Không tìm thấy request phù hợp với từ khóa lọc."}
            </div>
          ) : (
            <table className="w-full text-left border-collapse whitespace-nowrap">
              <thead className="sticky top-0 bg-bg-subtle border-b border-border z-10">
                <tr>
                  <th className="px-3 py-2 border-r border-border">DateTime</th>
                  <th className="px-3 py-2 border-r border-border">Model</th>
                  <th className="px-3 py-2 border-r border-border">Provider</th>
                  <th className="px-3 py-2 border-r border-border">Account</th>
                  <th className="px-3 py-2 border-r border-border text-right">In</th>
                  <th className="px-3 py-2 border-r border-border text-right">Out</th>
                  <th className="px-3 py-2 border-r border-border text-center">Status</th>
                  <th className="px-3 py-2 border-r border-border">Địa chỉ IP</th>
                  <th className="px-3 py-2 border-r border-border">Thiết bị</th>
                  <th className="px-3 py-2">Vị trí</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {filteredLogs.map((log, i) => {
                  const parts = log.split(" | ");
                  if (parts.length < 7) return null;

                  const status = parts[6];
                  let ip = (parts[7] || "127.0.0.1").replace("::1", "127.0.0.1").trim();
                  let legacyTool = "";
                  if (ip.includes(" ")) {
                    const match = ip.match(/^(.*?)\s*\((.*?)\)$/);
                    if (match) {
                      ip = match[1];
                      legacyTool = match[2];
                    }
                  }
                  const device = parts[8] || (legacyTool ? legacyTool.toUpperCase() : "—");
                  const location = parts[9] || (ip === "127.0.0.1" || ip === "localhost" ? "Máy nội bộ (Localhost)" : "Internet");

                  const isPending = status.includes("PENDING");
                  const isFailed = status.includes("FAILED") || status.includes("error") || status.startsWith("5") || status.startsWith("4");
                  const isSuccess = status.includes("OK") || status.includes("ok") || status === "200";

                  return (
                    <tr key={i} className={`hover:bg-primary/5 transition-colors ${isPending ? 'bg-primary/5' : ''}`}>
                      <td className="px-3 py-1.5 border-r border-border text-text-muted">{parts[0]}</td>
                      <td className="px-3 py-1.5 border-r border-border font-medium">{parts[1]}</td>
                      <td className="px-3 py-1.5 border-r border-border">
                        <span className="px-1.5 py-0.5 rounded bg-bg-subtle border border-border text-[10px] uppercase font-bold">
                          {parts[2]}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 border-r border-border truncate max-w-[150px]" title={parts[3]}>{parts[3]}</td>
                      <td className="px-3 py-1.5 border-r border-border text-right text-primary">{parts[4]}</td>
                      <td className="px-3 py-1.5 border-r border-border text-right text-success">{parts[5]}</td>
                      <td className={`px-3 py-1.5 border-r border-border text-center font-bold ${isSuccess ? 'text-success' :
                          isFailed ? 'text-error' :
                            'text-primary animate-pulse'
                        }`}>
                        {status}
                      </td>
                      <td className="px-3 py-1.5 border-r border-border font-mono text-[11px] font-semibold text-text-main">{ip}</td>
                      <td className="px-3 py-1.5 border-r border-border text-xs text-text-main font-medium">{device}</td>
                      <td className="px-3 py-1.5 text-xs text-text-muted">{location}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>
      <div className="flex items-center justify-between text-[11px] text-text-muted">
        <span>Hiển thị {filteredLogs.length} / {logs.length} requests gần nhất được ghi nhận từ database.</span>
        <span>Cập nhật liên tục mỗi 3 giây</span>
      </div>
    </div>
  );
}
