import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

export interface PlatformFeatures {
  write:        boolean;
  methods:      boolean;
  multi_server: boolean;
  digital_twin: boolean;
  twin_predictive: boolean;
  closed_loop_advisory: boolean;
  connector_hub: boolean;
  problem_templates: boolean;
  dashboards:   boolean;
  kafka:        boolean;
  alarm_eval:   boolean;
  scheduler:    boolean;
  edge_sync:    boolean;
}

const DEFAULT_FEATURES: PlatformFeatures = {
  write: false, methods: false, multi_server: false, digital_twin: false,
  twin_predictive: false, closed_loop_advisory: false, connector_hub: false,
  problem_templates: false,
  dashboards: false,
  kafka: false, alarm_eval: true, scheduler: false, edge_sync: false,
};

export function useFeatures(): PlatformFeatures {
  const { data } = useQuery({
    queryKey: ["features"],
    queryFn: () => api.get<PlatformFeatures>("/features").then((r) => r.data),
    staleTime: 60_000,
    retry: false,
  });
  return data ?? DEFAULT_FEATURES;
}
