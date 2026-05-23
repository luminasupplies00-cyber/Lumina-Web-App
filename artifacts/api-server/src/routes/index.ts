import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import settingsRouter from "./settings.js";
import zohoAuthRouter from "./zohoAuth.js";
import syncRouter from "./sync.js";
import threadsRouter from "./threads.js";
import rfqRouter from "./rfq.js";
import aiRouter from "./ai.js";
import suppliersRouter from "./suppliers.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(settingsRouter);
router.use(zohoAuthRouter);
router.use(syncRouter);
router.use(threadsRouter);
router.use(rfqRouter);
router.use(aiRouter);
router.use(suppliersRouter);

export default router;
