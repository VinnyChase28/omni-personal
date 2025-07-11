import { EventEmitter } from "events";
import fetch from "node-fetch";
import { ServerConfig, ServerInstance, HealthStatus } from "@mcp/schemas";
import { McpLogger } from "@mcp/utils";

export class MCPServerManager extends EventEmitter {
  private logger: McpLogger;
  private servers = new Map<string, ServerInstance>();
  private healthCheckIntervals = new Map<string, NodeJS.Timeout>();
  private serverConfigs: Record<string, ServerConfig>;

  constructor(serverConfigs: Record<string, ServerConfig>, logger: McpLogger) {
    super();
    this.logger = logger;
    this.serverConfigs = serverConfigs;
    Object.entries(serverConfigs).forEach(([serverId, config]) => {
      if (config.url) {
        this.servers.set(serverId, {
          id: serverId,
          serverId,
          url: config.url,
          lastHealthCheck: new Date(),
          isHealthy: false, // Start as unhealthy until first check passes
          activeConnections: 0,
          capabilities: config.capabilities,
        });
      }
    });
  }

  async initialize(): Promise<void> {
    this.logger.info(
      "Initializing server manager with network-based servers..."
    );
    for (const serverId of this.servers.keys()) {
      await this.performHealthCheck(serverId); // Perform initial health check
      this.startHealthChecks(serverId);
    }
  }

  async shutdown(): Promise<void> {
    this.logger.info("Shutting down server manager...");
    for (const interval of this.healthCheckIntervals.values()) {
      clearInterval(interval);
    }
    this.healthCheckIntervals.clear();
  }

  async getServerInstance(
    serverId: string,
    _capability?: string
  ): Promise<ServerInstance | null> {
    const server = this.servers.get(serverId);

    if (!server || !server.isHealthy) {
      this.logger.warn(
        `No healthy instances available for server: ${serverId}`
      );
      return null;
    }

    // This logic can be enhanced for load balancing if multiple URLs per service are supported
    server.activeConnections++;
    return server;
  }

  releaseServerInstance(instance: ServerInstance): void {
    if (instance.activeConnections > 0) {
      instance.activeConnections--;
    }
  }

  getHealthStatus(): HealthStatus {
    const status: HealthStatus = {};
    for (const [serverId, server] of this.servers.entries()) {
      status[serverId] = {
        instances: 1, // One URL per server in this model
        healthy: server.isHealthy ? 1 : 0,
        capabilities: server.capabilities,
        lastCheck: server.lastHealthCheck.toISOString(),
      };
    }
    return status;
  }

  private startHealthChecks(serverId: string): void {
    const server = this.servers.get(serverId);
    if (!server) return;

    // Use a default interval if not specified
    const healthCheckInterval =
      this.getServerConfig(serverId)?.healthCheckInterval || 30000;

    const interval = setInterval(
      () => this.performHealthCheck(serverId),
      healthCheckInterval
    );
    this.healthCheckIntervals.set(serverId, interval);
  }

  private async performHealthCheck(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server || !server.url) {
      return;
    }

    try {
      const healthUrl = `${server.url}/health`;

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const response = await fetch(healthUrl, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        if (!server.isHealthy) {
          this.logger.info(`Server '${serverId}' is now healthy.`);
        }
        server.isHealthy = true;
      } else {
        if (server.isHealthy) {
          this.logger.warn(
            `Server '${serverId}' is now unhealthy. Status: ${response.status}`
          );
        }
        server.isHealthy = false;
      }
    } catch (error: unknown) {
      if (server.isHealthy) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        this.logger.warn(
          `Health check failed for server '${serverId}'. Error: ${errorMessage}`
        );
      }
      server.isHealthy = false;
    } finally {
      server.lastHealthCheck = new Date();
    }
  }

  // Helper to get original config, if needed
  private getServerConfig(serverId: string): ServerConfig | undefined {
    return this.serverConfigs[serverId];
  }
}
