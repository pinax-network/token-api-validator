import { type ILogObj, Logger } from 'tslog';
import { config } from './config.js';

class AppLogger extends Logger<ILogObj> {
    constructor() {
        super({
            name: 'token-api-validator',
            minLevel: config.verbose ? 0 : 3,
            type: config.prettyLogging ? 'pretty' : 'json',
        });
    }
}

export const logger = new AppLogger();
