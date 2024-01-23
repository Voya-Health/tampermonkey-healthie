export interface DD_Window extends globalThis.Window {
    DD_LOGS?: {
        init: (config: DD_LogsInitConfigs) => void;
        onReady: (param: any) => void;
        logger: {
            info: (msg: string, context?: any) => void
        }
    };
    DD_RUM?: {
        init: (config: any) => void;
        onReady: (param: any) => void;
    };
}

export interface DD_LogsInitConfigs {
    clientToken: string,
    site: string,
    service?: string,
    env?: string
}

export interface DD_RumInitConfigs extends DD_LogsInitConfigs {
    applicationId: string
}

export interface DatadogConfig {
    logs_clientToken: string;
    rum_clientToken: string;
    rum_appId: string;
  }
  