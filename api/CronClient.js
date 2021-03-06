/**
 * Created by liuxing on 16/3/12.
 */
'use strict';

const Queue = require('bull');
const logger = require('winston');
const redis = require('redis');
const bluebird = require('bluebird');
var methods = {};
var parser = require('cron-parser');
var keysPrefix = 'bull:';
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);
var queue, redisClient;

/**
 * 根据函数名查找函数实现
 * @param name
 * @returns {*}
 */
function getMethod(name){
  return methods[name];
}

/**
 * 当前的任务还未结束 获取下一次定时任务的时间
 * @param interval interval 对象
 * @param next 当前的时间
 */
function getNextDate(interval, next){
  var date = new Date(next.toString());
  var timeOffset = date.getTime() - new Date().getTime();
  if (timeOffset < 1000) {
    next = interval.next();
    return getNextDate(interval, next);
  }else if (timeOffset < 60000) { // cron 格式的定时 小于1分钟 设置为1分钟,防止重复调用定时任务
    timeOffset = 60000;
  }
  return timeOffset;
}

function init(app, redisConfig) {
  keysPrefix += (app + ':');
  redisConfig.DB = redisConfig.db || 0;
  if (redisConfig.password) {
      redisConfig.auth_pass = redisConfig.password;
    redisConfig.opts = redisConfig.opts ? redisConfig.opts : {};
    redisConfig.opts.auth_pass = redisConfig.password;
    redisConfig.opts.password = redisConfig.password;
  }
  queue = Queue(app, {redis: redisConfig});
  redisClient = redis.createClient(redisConfig);
  redisClient.on("error", function () {})
  redisClient.select(redisConfig.DB);
  queue.on('ready', function () {
    logger.info('%s is ready', app);
  });

  queue.on('failed', function (job, err) {
    console.log('error', job.jobId);
    logger.log('error', err.stack);
  });

// 定时任务处理
  queue.process(function(job, done) {
    let task = job.data;
    getMethod(task.method).apply(this, task.params);
    var nextTask = task.rule && (task.rule.indexOf('*') > -1);
    if (nextTask) {
      publish(task); // 如果是重复任务则重新发布
    }
    done();
  });
}

/**
 * 检查定时任务的时间是否过期
 * @param rule  *    *    *    *    *    *
 * @return int 过期返回 false, 否则返回过期的毫秒数
 */
function getTTL(rule){
  var interval;
  try {
    interval = parser.parseExpression(rule);
    var next = interval.next();
    if (next.done) {
      return 0;
    }else {
      return getNextDate(interval, next); // 毫秒数
    }
  } catch (e) {
    if (rule instanceof Date) {
      return (rule.getTime() - new Date().getTime());
    }
    return 0;
  }
}

/**
 * delete all task uniqueID equals current uniqueID
 * @param uniqueID
 * @returns {Promise.<T>}
 */
function deleteUniqueTask(uniqueID) {
  return list().then((tasks) => {
    return bluebird.map(tasks, function (task) {
      var obj ;
      if (task.data) {
        obj = JSON.parse(task.data);
        if (obj.uniqueID && obj.uniqueID === uniqueID) {
          logger.info('delete task:', task.key);
          return del(task.key);
        }
      }else {
        return del(task.key);
      }
    });
  }).then(() => {
    queue.clean(1000);
    return bluebird.resolve();
  });
}

/**
 * 发布一个任务
 * @param task 任务内容
 */
function publish(task){
  function _publish(){
    // 存在定时
    if (task.rule) {
      //,并且过期时间小于0
      let ttl = Math.ceil(getTTL(task.rule));
      if (ttl < 0) {
        return ttl;
      }
      options.delay = ttl;  // 设置定时任务
    }
    logger.log('publish queue task %s ,' +
      ' running task after %s seconds', task.method, options.delay || -1);
    queue.add(task, options);
    return bluebird.resolve();
  }

  var options = {};
  if (task.uniqueID) {
    return deleteUniqueTask(task.uniqueID).then(() => {
      return _publish();
    });
  }else {
    return _publish()
  }
}

/**
 *
 * @param method 任务需要回调的函数引用
 */
function register(method){
  if (method && typeof method === 'function') {
    methods[method.name] = method;
  }
}


function list(){
  var result = [];
  return redisClient.keysAsync(keysPrefix + '*').then((ids) => {
    return bluebird.map(ids, function (id) {
      var key = id.split(':');
      if (id && key.length === 3 && parseInt(key[2]) > 0) {

        return redisClient.hgetallAsync(id).then((data) => {
          data.key = id;
          result.push(data);
          return data;
        });
      }
    })
  }).then(() => {
    return result;
  }).catch(function(err){
    console.error(err);
  });
}

/**
 * 删除 hash
 * @param jobID
 * @returns {*}
 */
function del(jobID){
  if (jobID) {
    var id = jobID.split(':')[2];
    return queue.getJob(id).then((job) => {
      return job && job.remove();
    });
  }
  return bluebird.resolve();
}

module.exports = function(app, redisConfig){
  init(app, redisConfig);
  return {
    publish: publish,
    register: register,
    list: list,
    del: del
  };
}
