import { Router } from "express";
import { manifestRouter } from "./manifestRoutes.js";
import { siliconflowRouter } from "./siliconflowRoutes.js";
import { infcontrolRouter } from "./infcontrolRoutes.js";
import { yieldMonitorRouter } from "./yieldMonitorRoutes.js";

export const apiRouter = Router();

apiRouter.use(manifestRouter);
apiRouter.use(siliconflowRouter);
apiRouter.use(infcontrolRouter);
apiRouter.use(yieldMonitorRouter);
