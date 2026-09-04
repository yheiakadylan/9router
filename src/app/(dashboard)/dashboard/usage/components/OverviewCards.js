"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

export default function OverviewCards({ stats }) {
  const totalImageRequests = stats.totalImageRequests ?? stats.totalRequests ?? 0;
  const imageModelsCount = stats.imageModelsCount ?? (stats.byModel ? Object.keys(stats.byModel).length : 0);
  const imageProvidersCount = stats.imageProvidersCount ?? (stats.byProvider ? Object.keys(stats.byProvider).length : 0);
  const successRate = stats.successRate ?? "100%";
  const avgDurationStr = stats.avgDurationStr ?? "—";

  const activeImageRequests = stats.activeCounts?.image ?? 0;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 sm:gap-4">
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-xs uppercase font-semibold">Ảnh đang xử lý</span>
        <span className="truncate text-2xl font-bold text-warning">{fmt(activeImageRequests)}</span>
        <span className="text-[11px] text-text-muted">request đang gọi upstream</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-xs uppercase font-semibold">Tổng số lượt Gen Ảnh</span>
        <span className="truncate text-2xl font-bold text-primary">{fmt(totalImageRequests)}</span>
        <span className="text-[11px] text-text-muted">lượt request gen hình</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-xs uppercase font-semibold">Thời gian Gen trung bình</span>
        <span className="truncate text-2xl font-bold text-purple-500 dark:text-purple-400">{avgDurationStr}</span>
        <span className="text-[11px] text-text-muted">tốc độ hoàn thành 1 tấm ảnh</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-xs uppercase font-semibold">Số Model Gen Ảnh</span>
        <span className="truncate text-2xl font-bold text-success">{fmt(imageModelsCount)}</span>
        <span className="text-[11px] text-text-muted">models</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-xs uppercase font-semibold">Nhà cung cấp (Providers)</span>
        <span className="truncate text-2xl font-bold text-info">{fmt(imageProvidersCount)}</span>
        <span className="text-[11px] text-text-muted">providers</span>
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-xs uppercase font-semibold">Trạng thái xử lý</span>
        <span className="truncate text-2xl font-bold text-warning">{successRate}</span>
        <span className="text-[11px] text-text-muted">tỉ lệ thành công</span>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
