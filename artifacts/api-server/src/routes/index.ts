import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import settingsRouter from "./settings.js";
import zohoAuthRouter from "./zohoAuth.js";
import syncRouter from "./sync.js";
import threadsRouter from "./threads.js";
import rfqRouter from "./rfq.js";
import aiRouter from "./ai.js";
import suppliersRouter from "./suppliers.js";
import supplierContactsRouter from "./supplierContacts.js";
import mailSendRouter from "./mailSend.js";
import aiCommandRouter from "./aiCommand.js";
import autopilotRouter from "./autopilot.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(settingsRouter);
router.use(zohoAuthRouter);
router.use(syncRouter);
router.use(threadsRouter);
router.use(rfqRouter);
router.use(aiRouter);
router.use(suppliersRouter);
router.use(supplierContactsRouter);
router.use(mailSendRouter);
router.use(aiCommandRouter);
router.use(autopilotRouter);

export default router;
