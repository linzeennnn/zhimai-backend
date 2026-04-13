const { Activity, User, Favorite } = require('../models');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const logger = require('../utils/logger');
const xss = require('xss');

class ActivityService {
    /**
     * 获取活动列表
     * @param {Object} query 查询参数
     * @returns {Promise<Object>} 分页后的活动列表
     */
    async getAllActivities(query = {}) {
        try {
            const { 
                type,           // 活动类型 activity_type
                status,         // 活动状态
                startDate,      // 开始日期筛选
                endDate,        // 结束日期筛选 
                organizer,      // 主办方
                keyword,        // 关键词搜索
                creditType,     // 学分类型 credit_type
                channel,        // 参与渠道 participation_channel
                targetAudience, // 目标受众 target_audience
                location,       // 地点搜索
                sortBy = 'start_time',    // 排序字段
                sortOrder = 'DESC',       // 排序方向
                page = 1, 
                pageSize = 10 
            } = query;

            const where = {};

            // 基础筛选条件
            if (type){
                if (type === '二课') {
                    where.activity_type = { [Op.in]: ['二课', '二课综测'] };
                  } else if (type === '综测') {
                    where.activity_type = { [Op.in]: ['综测', '二课综测'] };
                  } else {
                    where.activity_type = type;
                  }
            }
            if (status) where.status = status;
            if (creditType) where.credit_type = creditType;
            if (channel) where.participation_channel = channel;
            if (targetAudience) where.target_audience = { [Op.like]: `%${targetAudience}%` };
            
            // 时间范围筛选
            if (startDate) where.start_time = { [Op.gte]: startDate };
            if (endDate) where.end_time = { [Op.lte]: endDate };
            
            // 模糊搜索条件
            if (organizer) where.organizer = { [Op.like]: `%${organizer}%` };
            if (location) where.location = { [Op.like]: `%${location}%` };
            
            // 关键词搜索（标题、描述、主办方）
            if (keyword) {
                where[Op.or] = [
                    { title: { [Op.like]: `%${keyword}%` } },
                    { description: { [Op.like]: `%${keyword}%` } },
                    { organizer: { [Op.like]: `%${keyword}%` } },
                    { location: { [Op.like]: `%${keyword}%` } }
                ];
            }

            // 排序配置
            const validSortFields = ['start_time', 'end_time', 'created_at', 'title', 'status'];
            const validSortOrders = ['ASC', 'DESC'];
            const orderBy = validSortFields.includes(sortBy) ? sortBy : 'start_time';
            const orderDir = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';

            // 自动更新活动状态
            await this.updateActivitiesStatus();

            const { count, rows: activities } = await Activity.findAndCountAll({
                where,
                attributes: [
                    'activity_id',
                    'title',
                    'start_time',
                    'end_time',
                    'location',
                    'target_audience',
                    'organizer',
                    'description',
                    'activity_type',
                    'credit_type',
                    'participation_channel',
                    'image_url',
                    'link',
                    'status',
                    'max_participants',
                    'created_at',
                    'updated_at'
                ],
                order: [[orderBy, orderDir]],
                offset: (parseInt(page) - 1) * parseInt(pageSize),
                limit: parseInt(pageSize)
            });

            // 获取每个活动的收藏数
            const activitiesWithStats = await Promise.all(activities.map(async (activity) => {
                const favoriteCount = await Favorite.count({
                    where: { activity_id: activity.activity_id }
                });

                const activityData = activity.toJSON();
                return {
                    ...activityData,
                    statistics: {
                        favoriteCount
                    }
                };
            }));

            return {
                total: count,
                page: parseInt(page),
                pageSize: parseInt(pageSize),
                data: activitiesWithStats
            };
        } catch (error) {
            logger.error('获取活动列表失败:', error);
            throw new Error('获取活动列表失败');
        }
    }

    /**
     * 获取活动详情
     * @param {number} id 活动ID
     * @param {number} [userId] 当前用户ID（可选）
     * @returns {Promise<Object>} 活动详情
     */
    async getActivityById(id, userId = null) {
        try {
            const activity = await Activity.findByPk(id, {
                attributes: [
                    'activity_id',
                    'title',
                    'start_time',
                    'end_time',
                    'location',
                    'target_audience',
                    'organizer',
                    'description',
                    'activity_type',
                    'credit_type',
                    'participation_channel',
                    'image_url',
                    'link',
                    'status',
                    'max_participants',
                    'created_at',
                    'updated_at'
                ],
                include: [{
                    model: Favorite,
                    attributes: ['favorite_id'],
                    required: false,
                    where: userId ? { user_id: userId } : undefined
                }]
            });

            if (!activity) {
                throw new Error('活动不存在');
            }

            const activityData = activity.toJSON();
            const { Favorites, ...activityInfo } = activityData;  // 解构去除Favorites字段

            // 计算收藏信息
            const favorites = activityData.Favorites || [];
            const favoriteCount = await Favorite.count({
                where: { activity_id: id }
            });

            return {
                ...activityInfo,
                statistics: {
                    favoriteCount
                },
                isFavorited: favorites.length > 0
            };
        } catch (error) {
            logger.error('获取活动详情失败:', error);
            throw error;
        }
    }

    /**
     * 获取用户收藏的活动列表
     * @param {number} userId 用户ID
     * @returns {Promise<Array>} 活动列表
     */
    async getMyFavorites(reqMes) {
    try {
        const offset = (reqMes.page - 1) * reqMes.size;

        // 先从 Favorite 表查询用户收藏，按 created_at 排序并分页
        const favorites = await Favorite.findAll({
            where: { user_id: reqMes.userId },
            order: [['created_at', 'DESC']],
            limit: reqMes.size,
            offset: offset,
            include: [{
                model: Activity,
                attributes: [
                    'activity_id',
                    'title',
                    'start_time',
                    'end_time',
                    'location',
                    'target_audience',
                    'organizer',
                    'description',
                    'activity_type',
                    'credit_type',
                    'participation_channel',
                    'image_url',
                    'link',
                    'status',
                    'max_participants',
                    'created_at',
                    'updated_at'
                ]
            }]
        });
        return favorites.map(fav => {
            const activityData = fav.Activity.toJSON();
            return {
                ...activityData,
                favoriteTime: fav.created_at
            };
        });

    } catch (error) {
        logger.error('获取用户收藏的活动列表失败:', error);
        throw error;
    }
}

    /**
     * 收藏活动
     * @param {number} activityId 活动ID
     * @param {number} userId 用户ID
     * @returns {Promise<Object>} 收藏记录
     */
    async favoriteActivity(activityId, userId) {
        try {
            const activity = await Activity.findByPk(activityId);
            if (!activity) {
                throw new Error('活动不存在');
            }

            // 检查是否已收藏（包括软删除的记录）
            const existingFavorite = await Favorite.findOne({
                where: {
                    activity_id: activityId,
                    user_id: userId
                },
                paranoid: false // 包括软删除的记录
            });

            if (existingFavorite) {
                if (existingFavorite.deleted_at) {
                    // 如果是已删除的记录，恢复它
                    await existingFavorite.restore();
                    return existingFavorite;
                }
                throw new Error('该活动已在您的收藏列表中');
            }

            // 创建收藏记录
            const favorite = await Favorite.create({
                activity_id: activityId,
                user_id: userId
            });

            return favorite;
        } catch (error) {
            logger.error('收藏活动失败:', error);
            throw error;
        }
    }

    /**
     * 取消收藏活动
     * @param {number} activityId 活动ID
     * @param {number} userId 用户ID
     * @returns {Promise<boolean>} 是否成功
     */
    async unfavoriteActivity(activityId, userId) {
        try {
            const favorite = await Favorite.findOne({
                where: {
                    activity_id: activityId,
                    user_id: userId
                }
            });

            if (!favorite) {
                throw new Error('未收藏该活动');
            }

            await favorite.destroy();
            return true;
        } catch (error) {
            logger.error('取消收藏活动失败:', error);
            throw error;
        }
    }
    /**
     * 批量取消收藏活动
     * @param {number[]} activityId 活动ID
     * @param {number} userId 用户ID
     * @returns {Promise<boolean>} 是否成功
     */
    async deleteFavorites(activityIds, userId) {
        try {
            if (!Array.isArray(activityIds) || activityIds.length === 0) {
                throw new Error('删除列表为空');
            }

            // 批量查询这些收藏记录
            const favorites = await Favorite.findAll({
                where: {
                    activity_id: activityIds,
                    user_id: userId
                }
            });

            if (favorites.length === 0) {
                throw new Error('未找到该活动');
            }
            // 批量删除
            await Favorite.destroy({
                where: {
                    activity_id: activityIds,
                    user_id: userId
                }
            });
            return {
                successCount: favorites.length,
                failCount: activityIds.length - favorites.length
            };
        } catch (error) {
            logger.error('批量取消收藏活动失败:', error);
            throw error;
        }
    }
    /**
     * 清空用户所有收藏
     * @param {number} userId 用户ID
     * @returns {Promise<number>} 删除的收藏数量
     */
    async clearFavorites(userId) {
        try {
            // 统计要删除的数量
            const count = await Favorite.count({
                where: { user_id: userId }
            });

            if (count === 0) {
                return 0; // 没有可删除的记录
            }

            // 一次性删除当前用户所有收藏
            await Favorite.destroy({
                where: { user_id: userId }
            });

            return count;
        } catch (error) {
            logger.error('清空用户收藏失败:', error);
            throw error;
        }
    }
    /**
     * 创建活动
     * @param {Object} activityData 活动数据
     * @returns {Promise<Object>} 创建的活动
     */
    async createActivity(activityData) {
        try {
            // 数据验证
            this.validateActivityData(activityData);

            // XSS过滤
            const sanitizedData = {
                ...activityData,
                title: xss(activityData.title),
                description: activityData.description ? xss(activityData.description) : null,
                location: activityData.location ? xss(activityData.location) : null,
                organizer: activityData.organizer ? xss(activityData.organizer) : null
            };

            const activity = await Activity.create(sanitizedData);
            return activity;
        } catch (error) {
            logger.error('创建活动失败:', error);
            throw error;
        }
    }

    /**
     * 更新活动
     * @param {number} id 活动ID
     * @param {Object} updateData 更新数据
     * @returns {Promise<Object>} 更新后的活动
     */
    async updateActivity(id, updateData) {
        try {
            const activity = await Activity.findByPk(id);

            if (!activity) {
                throw new Error('活动不存在');
            }

            // 数据验证
            this.validateActivityData(updateData, true);

            // XSS过滤
            const sanitizedData = {
                ...updateData,
                title: updateData.title ? xss(updateData.title) : undefined,
                description: updateData.description ? xss(updateData.description) : undefined,
                location: updateData.location ? xss(updateData.location) : undefined,
                organizer: updateData.organizer ? xss(updateData.organizer) : undefined
            };

            await activity.update(sanitizedData);
            return activity;
        } catch (error) {
            logger.error('更新活动失败:', error);
            throw error;
        }
    }

    /**
     * 更新活动状态
     * @param {number} id 活动ID
     * @param {string} status 新状态
     * @returns {Promise<Object>} 更新后的活动
     */
    async updateActivityStatus(id, status) {
        try {
            const activity = await Activity.findByPk(id);
            if (!activity) {
                return null;
            }

            // 验证状态转换的合法性
            this.validateStatusTransition(activity.status, status);

            await activity.update({ status });
            logger.info('活动状态更新成功:', { activityId: id, status });
            return activity;
        } catch (error) {
            logger.error('更新活动状态失败:', error);
            throw error;
        }
    }

    /**
     * 删除活动（软删除）
     * @param {number} id 活动ID
     * @returns {Promise<boolean>} 是否成功
     */
    async deleteActivity(id) {
        try {
            const activity = await Activity.findByPk(id);

            if (!activity) {
                throw new Error('活动不存在');
            }

            await activity.destroy();
            return true;
        } catch (error) {
            logger.error('删除活动失败:', error);
            throw error;
        }
    }

    /**
     * 自动更新活动状态
     * @private
     */
    async updateActivitiesStatus() {
        try {
            const now = new Date();

            // 更新进行中的活动
            await Activity.update(
                { status: '进行中' },
                {
                    where: {
                        start_time: { [Op.lte]: now },
                        end_time: { [Op.gt]: now },
                        status: '未开始'
                    }
                }
            );

            // 更新已结束的活动
            await Activity.update(
                { status: '已结束' },
                {
                    where: {
                        end_time: { [Op.lte]: now },
                        status: '进行中'
                    }
                }
            );
        } catch (error) {
            logger.error('更新活动状态失败:', error);
        }
    }

    /**
     * 验证活动数据
     * @param {Object} data 活动数据
     * @param {boolean} isUpdate 是否是更新操作
     * @private
     */
    validateActivityData(data, isUpdate = false) {
        const errors = [];

        if (!isUpdate || data.title !== undefined) {
            if (!data.title || data.title.trim().length === 0) {
                errors.push('活动标题不能为空');
            }
            if (data.title && data.title.length > 100) {
                errors.push('活动标题不能超过100个字符');
            }
        }

        if (!isUpdate || data.start_time !== undefined) {
            if (!data.start_time) {
                errors.push('开始时间不能为空');
            }
        }

        if (!isUpdate || data.end_time !== undefined) {
            if (!data.end_time) {
                errors.push('结束时间不能为空');
            }
            if (data.start_time && data.end_time && new Date(data.end_time) <= new Date(data.start_time)) {
                errors.push('结束时间必须晚于开始时间');
            }
        }

        if (errors.length > 0) {
            throw new Error(errors.join('; '));
        }
    }

    /**
     * 验证状态转换的合法性
     * @param {string} currentStatus 当前状态
     * @param {string} newStatus 新状态
     */
    validateStatusTransition(currentStatus, newStatus) {
        const validStatus = ['未开始', '进行中', '已结束'];
        if (!validStatus.includes(newStatus)) {
            throw new Error('无效的状态值');
        }

        // 定义状态转换规则
        const validTransitions = {
            '未开始': ['进行中'],
            '进行中': ['已结束'],
            '已结束': []
        };

        if (!validTransitions[currentStatus].includes(newStatus)) {
            throw new Error('非法的状态转换');
        }
    }

    /**
     * 获取活动统计信息
     * @returns {Promise<Object>} 统计信息
     */
    async getActivityStatistics() {
        try {
            const [
                totalCount,
                statusStats,
                typeStats,
                creditTypeStats,
                channelStats
            ] = await Promise.all([
                // 总活动数
                Activity.count(),
                
                // 按状态统计
                Activity.findAll({
                    attributes: [
                        'status',
                        [sequelize.fn('COUNT', sequelize.col('activity_id')), 'count']
                    ],
                    group: ['status']
                }),
                
                // 按活动类型统计
                Activity.findAll({
                    attributes: [
                        'activity_type',
                        [sequelize.fn('COUNT', sequelize.col('activity_id')), 'count']
                    ],
                    where: {
                        activity_type: { [Op.ne]: null }
                    },
                    group: ['activity_type']
                }),
                
                // 按学分类型统计
                Activity.findAll({
                    attributes: [
                        'credit_type',
                        [sequelize.fn('COUNT', sequelize.col('activity_id')), 'count']
                    ],
                    where: {
                        credit_type: { [Op.ne]: null }
                    },
                    group: ['credit_type']
                }),
                
                // 按参与渠道统计
                Activity.findAll({
                    attributes: [
                        'participation_channel',
                        [sequelize.fn('COUNT', sequelize.col('activity_id')), 'count']
                    ],
                    where: {
                        participation_channel: { [Op.ne]: null }
                    },
                    group: ['participation_channel']
                })
            ]);

            return {
                total: totalCount,
                byStatus: statusStats.map(item => ({
                    status: item.status,
                    count: parseInt(item.get('count'))
                })),
                byType: typeStats.map(item => ({
                    type: item.activity_type,
                    count: parseInt(item.get('count'))
                })),
                byCreditType: creditTypeStats.map(item => ({
                    creditType: item.credit_type,
                    count: parseInt(item.get('count'))
                })),
                byChannel: channelStats.map(item => ({
                    channel: item.participation_channel,
                    count: parseInt(item.get('count'))
                }))
            };
        } catch (error) {
            logger.error('获取活动统计失败:', error);
            throw error;
        }
    }

    /**
     * 获取热门活动（按收藏数排序）
     * @param {number} limit 限制数量
     * @returns {Promise<Array>} 热门活动列表
     */
    async getPopularActivities(limit = 10) {
        try {
            const activities = await Activity.findAll({
                attributes: [
                    'activity_id',
                    'title',
                    'start_time',
                    'end_time',
                    'location',
                    'organizer',
                    'activity_type',
                    'status',
                    'image_url'
                ],
                include: [{
                    model: Favorite,
                    attributes: [],
                    required: false
                }],
                group: ['Activity.activity_id'],
                order: [
                    [sequelize.fn('COUNT', sequelize.col('Favorites.favorite_id')), 'DESC'],
                    ['start_time', 'DESC']
                ],
                limit: parseInt(limit),
                subQuery: false
            });

            // 获取每个活动的收藏数
            const activitiesWithStats = await Promise.all(activities.map(async (activity) => {
                const favoriteCount = await Favorite.count({
                    where: { activity_id: activity.activity_id }
                });

                return {
                    ...activity.toJSON(),
                    favoriteCount
                };
            }));

            return activitiesWithStats;
        } catch (error) {
            logger.error('获取热门活动失败:', error);
            throw error;
        }
    }

    /**
     * 获取活动分类信息
     * @returns {Promise<Object>} 分类信息
     */
    async getActivityCategories() {
        try {
            const [activityTypes, creditTypes, channels] = await Promise.all([
                Activity.findAll({
                    attributes: ['activity_type'],
                    where: { activity_type: { [Op.ne]: null } },
                    group: ['activity_type']
                }),
                Activity.findAll({
                    attributes: ['credit_type'],
                    where: { credit_type: { [Op.ne]: null } },
                    group: ['credit_type']
                }),
                Activity.findAll({
                    attributes: ['participation_channel'],
                    where: { participation_channel: { [Op.ne]: null } },
                    group: ['participation_channel']
                })
            ]);

            return {
                activityTypes: activityTypes.map(item => item.activity_type).filter(Boolean),
                creditTypes: creditTypes.map(item => item.credit_type).filter(Boolean),
                channels: channels.map(item => item.participation_channel).filter(Boolean)
            };
        } catch (error) {
            logger.error('获取活动分类失败:', error);
            throw error;
        }
    }
}

module.exports = new ActivityService(); 