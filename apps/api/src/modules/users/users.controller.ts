import { asyncHandler } from '../../utils/asyncHandler.js';
import { usersService } from './users.service.js';
import {
  createUserSchema,
  listUsersSchema,
  updateUserSchema,
  userIdSchema,
  userStatusSchema,
} from './users.validation.js';

export const usersController = {
  list: asyncHandler(async (req, res) => {
    res.json(
      await usersService.list(req.auth!, listUsersSchema.parse(req.query)),
    );
  }),
  get: asyncHandler(async (req, res) => {
    res.json({
      user: await usersService.get(
        req.auth!,
        userIdSchema.parse(req.params.id),
      ),
    });
  }),
  create: asyncHandler(async (req, res) => {
    res
      .status(201)
      .json({
        user: await usersService.create(
          req.auth!,
          createUserSchema.parse(req.body),
        ),
      });
  }),
  update: asyncHandler(async (req, res) => {
    res.json({
      user: await usersService.update(
        req.auth!,
        userIdSchema.parse(req.params.id),
        updateUserSchema.parse(req.body),
      ),
    });
  }),
  status: asyncHandler(async (req, res) => {
    const { isActive } = userStatusSchema.parse(req.body);
    res.json({
      user: await usersService.setStatus(
        req.auth!,
        userIdSchema.parse(req.params.id),
        isActive,
      ),
    });
  }),
};
