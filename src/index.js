require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection, REST, Routes, AttachmentBuilder } = require('discord.js');
const interactionHandler = require('./interactionHandler');
const fs = require('fs-extra');
const path = require('path');
const canvafy = require('canvafy');
const cron = require('node-cron');
const saveInterval = 10000;
const userMessageCache = {};
const streakCooldowns = new Map();
const clientId = process.env.CLIENT_ID;
const token = process.env.TOKEN;
const userMessageData = {};
let saveQueue = {};
let databaseLocks = {};

function isValidJson(data) {
    try {
        JSON.stringify(data);
        return true;
    } catch (error) {
        return false;
    }
}

async function sanitizeDatabase(data) {
    const validData = {};
    for (const [key, value] of Object.entries(data)) {
        if (isValidJson(value)) {
            validData[key] = value;
        } else {
            console.error(`Invalid entry detected for key ${key}`);
        }
    }
    return validData;
}

function repairJsonStructure(rawContent) {
    const repairedData = {};
    let currentChunk = '';

    for (let i = 0; i < rawContent.length; i++) {
        const char = rawContent[i];
        currentChunk += char;

        try {
            const parsedChunk = JSON.parse(currentChunk);
            Object.assign(repairedData, parsedChunk);
            currentChunk = '';
        } catch (err) {
            if (err.name === 'SyntaxError') {
            } else {
                console.error(`Error parsing JSON chunk: ${err.message}`);
            }
        }
    }

    try {
        const remainingParsedChunk = JSON.parse(currentChunk);
        Object.assign(repairedData, remainingParsedChunk);
    } catch (err) {
        console.warn(`Remaining chunk could not be parsed: ${err.message}`);
    }

    return repairedData;
}

async function loadDatabase(filePath) {
    while (databaseLocks[filePath]) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    try {
        const data = await fs.readFile(filePath, 'utf8');
        const parsedData = JSON.parse(data);
        return await sanitizeDatabase(parsedData);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`File not found: ${filePath}, initializing an empty object.`);
            await saveDatabase(filePath, {});
            return {};
        } else {
            console.warn(`Failed to parse or load JSON completely: ${error.message}`);
        }

        console.log('Attempting to repair the broken JSON structure...');
        const repairedData = repairJsonStructure(data);
        return repairedData;
    }
}


async function validateAndAssembleData(data) {
    if (data && Object.keys(data).length === 0) {
        console.warn('Data is empty but allowed for initialization.');
        return true;
    }

    if (!data || Object.keys(data).length === 0) {
        console.warn('Data is empty or incomplete');
        return false;
    }
    return true;
}

async function saveDatabase(filePath, data) {
    if (!saveQueue[filePath]) {
        saveQueue[filePath] = [];
    }

    return new Promise((resolve, reject) => {
        saveQueue[filePath].push(async () => {
            if (databaseLocks[filePath]) {
                resolve();
                return;
            }

            if (!(await validateAndAssembleData(data))) {
                console.warn(`Invalid or incomplete data, skipping save for ${filePath}.`);
                resolve();
                return;
            }

            try {
                databaseLocks[filePath] = true;
                const sanitizedData = await sanitizeDatabase(data);
                const jsonData = JSON.stringify(sanitizedData, null, 2);

                await fs.writeFile(filePath, jsonData, 'utf8');
                resolve();
            } catch (error) {
                console.error(`Failed to save database file ${filePath}: ${error.message}`);
                reject(error);
            } finally {
                databaseLocks[filePath] = false;
                saveQueue[filePath].shift();
                if (saveQueue[filePath].length > 0) {
                    saveQueue[filePath][0]();
                }
            }
        });

        if (saveQueue[filePath].length === 1) {
            saveQueue[filePath][0]();
        }
    });
}

async function initializeDatabase(guildId) {
    try {
        const dbPath = path.join(__dirname, '..', 'databases', guildId);

        if (!(await fs.pathExists(dbPath))) {
            console.log(`Creating directory for guild ${guildId}: ${dbPath}`);
            await fs.ensureDir(dbPath);

            const initialConfig = {
                streakSystem: {
                    enabled: false,
                    streakThreshold: 4,
                    isGymClassServer: false,
                    enabledDate: new Date().toISOString(),
                },
                messageLeaderSystem: {
                    enabled: false,
                },
                levelSystem: {
                    enabled: false,
                    xpPerMessage: 10,
                    levelMultiplier: 1.5,
                    levelUpMessages: true,
                    rewards: {},
                },
                reportSettings: {
                    weeklyReportChannel: "",
                    monthlyReportChannel: "",
                },
                channels: {},
                roles: {},
            };

            const initialUserDatabase = {}; // Initialize as an empty object

            // Save both the config and user database, allowing empty user database initialization
            await saveDatabase(path.join(dbPath, 'config.json'), initialConfig);
            await saveDatabase(path.join(dbPath, 'userDatabase.json'), initialUserDatabase);

            return true;
        } else {
            const configPath = path.join(dbPath, 'config.json');
            const config = await loadDatabase(configPath);

            // Add default enabledDate if not present
            if (!config.streakSystem.enabledDate) {
                config.streakSystem.enabledDate = new Date().toISOString();
                await saveDatabase(configPath, config);
            }

            return false;
        }
    } catch (error) {
        console.error(`Failed to initialize database for guild ${guildId}: ${error.message}`);
        return false;
    }
}


// Initialize the Discord client
if (!clientId || !token) {
    console.error("Missing CLIENT_ID or TOKEN in .env file.");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
});

// Load commands
client.commands = new Collection();
const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    try {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);

        if (command.data) {
            client.commands.set(command.data.name, command);
            commands.push(command.data.toJSON());
            console.log(`Loaded command: ${command.data.name}`);
        } else {
            console.error(`Command ${file} is missing 'data' property and was not loaded.`);
        }
    } catch (error) {
        console.error(`Failed to load command ${file}: ${error.message}`);
    }
}

// Register global commands
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    const rest = new REST({ version: '10' }).setToken(token);

    try {
        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(`Error registering commands: ${error.message}`);
    }

    try {
        const guilds = client.guilds.cache.map(guild => guild.id);
        for (const guildId of guilds) {
            const dbCreated = await initializeDatabase(guildId);
            if (dbCreated) {
                const guild = client.guilds.cache.get(guildId);
                if (guild) {
                    await sendConfigMessage(guild);
                }
            }
        }
    } catch (error) {
        console.error(`Error during guild initialization: ${error.message}`);
    }

    setInterval(() => {
        flushCacheToDisk();
    }, saveInterval);

    scheduleDailyReset();
    setTimeout(scheduleMessageLeaderAnnounce, 2000);
    scheduleWeeklyReport();
    scheduleMonthlyReport();
});

client.on('interactionCreate', async interaction => {
    try {
        await interactionHandler(client, interaction); // Call the interactionHandler
    } catch (error) {
        console.error(`Error handling interaction: ${error}`);
    }
});

client.on('guildCreate', async (guild) => {
    try {
        const dbCreated = await initializeDatabase(guild.id);
        if (dbCreated) {
            await sendConfigMessage(guild);
        }
    } catch (error) {
        console.error(`Error during guild creation: ${error.message}`);
    }
});

// Helper function to calculate message similarity
function getSimilarityScore(text1, text2) {
    const [shorter, longer] = text1.length < text2.length ? [text1, text2] : [text2, text1];
    const editDistance = levenshteinDistance(shorter, longer);
    return (longer.length - editDistance) / longer.length;
}

// Levenshtein distance for calculating message differences
function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b[i - 1] === a[j - 1]) matrix[i][j] = matrix[i - 1][j - 1];
            else matrix[i][j] = Math.min(
                matrix[i - 1][j - 1] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j] + 1
            );
        }
    }
    return matrix[b.length][a.length];
}

// Spam detection function
function detectSpam(message, userId) {
    const currentTime = Date.now();
    const userData = userMessageData[userId] || { lastMessage: null, lastTime: currentTime };

    // Check if the time difference between current and last message is less than 2.5 seconds
    const timeDifference = currentTime - userData.lastTime;

    // Check similarity between current and last message
    const similarityScore = userData.lastMessage
        ? getSimilarityScore(userData.lastMessage, message.content)
        : 0;

    // If the message is similar (>85% similarity) and sent within 2.5 seconds, flag as spam
    if (timeDifference < 2500 && similarityScore > 0.85) {
        console.log(`[SPAM DETECTION] Rapidly sent similar messages.`);
        return true;
    }

    // Update user's last message and time
    userMessageData[userId] = {
        lastMessage: message.content,
        lastTime: currentTime
    };

    return false;
}

function migrateUserData(oldData) {
    const newData = {};

    for (const [userId, userData] of Object.entries(oldData)) {
        const migratedData = { ...userData }; // Copy the old data as the base

        // Move 'xp' and 'level' fields into the new 'experience' object
        if (userData.xp !== undefined && userData.level !== undefined) {
            migratedData.experience = {
                totalXp: userData.xp,
                level: userData.level
            };
            delete migratedData.xp;
            delete migratedData.level;
        } else {
            // Ensure experience object exists if missing
            migratedData.experience = userData.experience || {
                totalXp: 0,
                level: 0
            };
        }

        // Handle the 'lastMessageTime' and 'lastMessageContent' migration to the 'lastMessage' field
        if (userData.lastMessageTime !== undefined && userData.lastMessageContent !== undefined) {
            migratedData.lastMessage = {
                time: userData.lastMessageTime,
                content: userData.lastMessageContent,
                date: userData.lastActiveDate || new Date().toISOString().split('T')[0] // Fallback to today if missing
            };
            delete migratedData.lastMessageTime;
            delete migratedData.lastMessageContent;
            delete migratedData.lastActiveDate;
        } else {
            // Ensure lastMessage object exists if missing
            migratedData.lastMessage = userData.lastMessage || {
                time: Date.now(),
                content: "",
                date: new Date().toISOString().split('T')[0]
            };
        }

        // Handle any additional field transformations if needed

        newData[userId] = migratedData;
    }

    return newData;
}

async function loadAndMigrateUserData(filePath) {
    const data = await loadDatabase(filePath);
    const migratedData = migrateUserData(data);
    await saveDatabase(filePath, migratedData);
    return migratedData;
}



client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    const userId = message.author.id;

    if (!detectSpam(message, userId)) {
        await handleUserMessage(message.guild.id, userId, message.channel, message);
    }
});

async function handleUserMessage(guildId, userId, channel, message) {
    try {
        const configPath = path.join(__dirname, '..', 'databases', guildId, 'config.json');
        const userDbPath = path.join(__dirname, '..', 'databases', guildId, 'userDatabase.json');

        // Load the config and userDatabase
        const config = await loadDatabase(configPath);
        let userDatabase = await loadAndMigrateUserData(userDbPath);

        // Initialize a user entry if it doesn't exist
        if (!userDatabase[userId]) {
            userDatabase[userId] = {
                streak: 0,
                highestStreak: 0,
                messages: 0,
                threshold: parseInt(config.streakSystem.streakThreshold) || 10,
                receivedDaily: false,
                messageLeaderWins: 0,
                highestMessageCount: 0,
                mostConsecutiveLeader: 0,
                totalMessages: 0,
                daysTracked: 0,
                averageMessagesPerDay: 0,
                activeDaysCount: 0,
                longestInactivePeriod: 0,
                lastStreakLoss: null,
                messageHeatmap: [],
                milestones: [],
                rolesAchieved: [],
                experience: { totalXp: 0, level: 0 }, // Initialize experience object
                boosters: 1,
                lastMessage: { time: 0, content: '', date: null },
                channelsParticipated: [],
                mentionsRepliesCount: { mentions: 0, replies: 0 }
            };
        }

        const now = Date.now();
        const today = new Date().toISOString().split('T')[0];
        const streakCooldown = 3000;
        const lastStreakUpTime = streakCooldowns.get(userId) || 0;

        // Update lastMessage field
        userDatabase[userId].lastMessage = {
            time: now,
            content: message.content,
            date: today
        };

        // Track participation in channels
        if (!Array.isArray(userDatabase[userId].channelsParticipated)) {
            userDatabase[userId].channelsParticipated = [];
        }
        if (!userDatabase[userId].channelsParticipated.includes(channel.id)) {
            userDatabase[userId].channelsParticipated.push(channel.id);
        }

        // Track mentions and replies
        if (message.mentions?.users?.has(userId)) {
            userDatabase[userId].mentionsRepliesCount.mentions += 1;
        }
        if (message.type === 'REPLY') {
            userDatabase[userId].mentionsRepliesCount.replies += 1;
        }

        // Check streak cooldown
        if (now - lastStreakUpTime < streakCooldown) {
            return;
        }

        // Spam detection (add your own detectSpam logic here)
        if (detectSpam(message, userDatabase, userId)) {
            return;
        }

        // Handle the level system (XP gain and level-up)
        if (config.levelSystem.enabled) {
            const xpGain = Math.max(0, config.levelSystem.xpPerMessage * (userDatabase[userId].boosters || 1));
            userDatabase[userId].experience.totalXp += xpGain;
            const xpRequired = Math.floor(100 * Math.pow(config.levelSystem.levelMultiplier, userDatabase[userId].experience.level));

            // Handle leveling up
            if (userDatabase[userId].experience.totalXp >= xpRequired) {
                userDatabase[userId].experience.level++;
                userDatabase[userId].experience.totalXp -= xpRequired;

                // Handle reward roles
                const rewardRoleKey = `roleLevel${userDatabase[userId].experience.level}`;
                const rewardRole = config.levelSystem[rewardRoleKey];

                if (!rewardRole) {
                    console.error(`No reward defined for level ${userDatabase[userId].experience.level} in guild ${guildId}`);
                } else {
                    await assignRole(guildId, userId, rewardRole);
                }

                // Level-up message
                const levelUpChannelId = config.levelSystem.channelLevelUp || channel.id;
                const levelUpChannel = channel.guild.channels.cache.get(levelUpChannelId) || channel;

                if (levelUpChannel && levelUpChannel.isTextBased()) {
                    await levelUpChannel.send(`🎉 <@${userId}> has leveled up to level ${userDatabase[userId].experience.level}!`);
                }
            }
        }

        // Handle the streak system
        if (config.streakSystem.enabled) {
            if (userDatabase[userId].threshold > 0) {
                userDatabase[userId].threshold -= 1;
            }

            if (userDatabase[userId].threshold === 0 && !userDatabase[userId].receivedDaily) {
                userDatabase[userId].streak += 1;
                userDatabase[userId].receivedDaily = true;

                if (userDatabase[userId].streak > userDatabase[userId].highestStreak) {
                    userDatabase[userId].highestStreak = userDatabase[userId].streak;
                }

                // Announce streak milestone
                const streakChannelId = config.streakSystem.channelStreakOutput || channel.id;
                const streakChannel = channel.guild.channels.cache.get(streakChannelId);

                let milestoneRole = null;
                let milestone = 0;

                for (const key in config.streakSystem) {
                    if (key.startsWith('role') && key.endsWith('day')) {
                        const streakDays = parseInt(key.replace('role', '').replace('day', ''));
                        if (userDatabase[userId].streak === streakDays) {
                            milestone = streakDays;
                            milestoneRole = await assignRole(guildId, userId, config.streakSystem[key]);
                            break;
                        }
                    }
                }

                if (milestone > 0) {
                    userDatabase[userId].milestones.push({ milestone, date: new Date().toISOString() });
                    if (milestoneRole) {
                        userDatabase[userId].rolesAchieved.push(milestoneRole.name);
                    }
                }

                // Create streak-up image using canvafy
                const streakUpImage = await new canvafy.LevelUp()
                    .setAvatar(channel.guild.members.cache.get(userId).user.displayAvatarURL())
                    .setBackground(
                        "image",
                        "https://img.freepik.com/premium-vector/red-fog-smoke-isolated-transparent-background-red-cloudiness-mist-smog-background-vector-realistic-illustration_221648-615.jpg"
                    )
                    .setUsername(channel.guild.members.cache.get(userId).user.username)
                    .setBorder("#FF0000")
                    .setAvatarBorder("#FFFFFF")
                    .setOverlayOpacity(0.7)
                    .setLevels(
                        userDatabase[userId].streak - 1,
                        userDatabase[userId].streak
                    )
                    .build();

                let streakMessage = `🎉 <@${userId}> has upped their streak to ${userDatabase[userId].streak}!!`;
                if (milestoneRole) {
                    streakMessage += ` They now have the ${milestone} Day Streak Role!`;
                }

                if (streakChannel && streakChannel.isTextBased()) {
                    await streakChannel.send({
                        content: streakMessage,
                        files: [
                            {
                                attachment: streakUpImage,
                                name: `streak-${userId}.png`,
                            },
                        ],
                    });
                }
                streakCooldowns.set(userId, now);
            }
        }

        // Message count tracking
        userDatabase[userId].messages += 1;
        userDatabase[userId].totalMessages += 1;

        // Handle message heatmap
        if (!Array.isArray(userDatabase[userId].messageHeatmap)) {
            userDatabase[userId].messageHeatmap = [];
        }

        const lastHeatmapEntry = userDatabase[userId].messageHeatmap.find(entry => entry.date === today);
        if (lastHeatmapEntry) {
            lastHeatmapEntry.messages += 1;
        } else {
            userDatabase[userId].messageHeatmap.push({ date: today, messages: 1 });
        }

        // Save the updated user database
        await saveDatabase(userDbPath, userDatabase);

    } catch (error) {
        console.error(`Error handling user message for user ${userId} in guild ${guildId}: ${error.message}`);
    }
}

// Daily reset logic
async function resetDailyStreaks() {
    try {
        const guilds = client.guilds.cache.map(guild => guild.id);
        for (const guildId of guilds) {
            const userDbPath = path.join(__dirname, '..', 'databases', guildId, 'userDatabase.json');
            const configPath = path.join(__dirname, '..', 'databases', guildId, 'config.json');

            if (await fs.pathExists(userDbPath) && await fs.pathExists(configPath)) {
                const userDatabase = await fs.readJson(userDbPath);
                const config = await fs.readJson(configPath);

                const messageThreshold = config.streakSystem.streakThreshold || 10;
                const today = new Date().toISOString().split('T')[0];

                for (const userId in userDatabase) {
                    const userData = userDatabase[userId];

                    if (!userData.messageHeatmap.some(entry => entry.date === today)) {
                        userData.messageHeatmap.push({ date: today, messages: 0 });
                    }

                    if (userData.streak > 0 && !userData.receivedDaily && userData.threshold > 0) {
                        const oldStreak = userData.streak;
                        userData.streak = 0;
                        await removeStreakRoles(guildId, userId, config, oldStreak);

                        userData.lastStreakLoss = new Date().toISOString();
                    }

                    userData.daysTracked += 1;
                    userData.totalMessages += userData.dailyMessageCount;
                    userData.averageMessagesPerDay = userData.totalMessages / userData.daysTracked;
                    userData.dailyMessageCount = 0;

                    if (userData.dailyMessageCount === 0) {
                        const lastActiveDate = userData.messageHeatmap && userData.messageHeatmap.length > 0
                            ? new Date(userData.messageHeatmap[userData.messageHeatmap.length - 1].date)
                            : new Date();
                        const inactiveDays = Math.floor((new Date() - lastActiveDate) / (1000 * 60 * 60 * 24));
                        userData.longestInactivePeriod = Math.max(userData.longestInactivePeriod || 0, inactiveDays);
                    }

                    userData.threshold = messageThreshold;
                    userData.receivedDaily = false;

                    if (new Date().getDay() === 0) {
                        userData.messagesInCurrentWeek = 0;
                    }
                }

                await fs.writeJson(userDbPath, userDatabase, { spaces: 2 });
            }
        }
    } catch (error) {
        console.error(`Error during daily streak reset: ${error.message}`);
    }
}

// Function to remove streak roles
async function removeStreakRoles(guildId, userId, config, oldStreak) {
    try {
        const guild = client.guilds.cache.get(guildId);
        let member;

        try {
            member = await guild.members.fetch(userId);
        } catch (error) {
            console.error(`Failed to fetch member with ID ${userId} in guild ${guildId}: ${error.message}`);
            return;
        }

        if (!member) {
            console.error(`Could not find member with ID ${userId} in guild ${guildId}.`);
            return;
        }

        const rolesToRemove = [];

        for (const key in config.streakSystem) {
            if (key.startsWith('role') && key.endsWith('day')) {
                const streakDays = parseInt(key.replace('role', '').replace('day', ''));
                if (oldStreak >= streakDays) {
                    const role = guild.roles.cache.get(config.streakSystem[key]);
                    if (role && member.roles.cache.has(role.id)) {
                        rolesToRemove.push(role.id);
                    }
                }
            }
        }

        const removalMessage = `You failed to send your required messages yesterday and therefore lost your ${oldStreak}-day message streak in the ${guild.name} server!`;

        try {
            await member.send(removalMessage);
        } catch (error) {
            console.error(`Failed to send DM to user ${userId} in guild ${guildId}: ${error.message}`);
            if (error.code === 50007) {
                console.warn(`User ${userId} has DMs disabled or has blocked the bot.`);
            } else {
                console.error(`Unexpected error when sending DM to user ${userId}: ${error.message}`);
            }

            const streakChannelId = config.streakSystem.channelStreakOutput;
            const streakChannel = guild.channels.cache.get(streakChannelId);
            if (streakChannel && streakChannel.isTextBased()) {
                await streakChannel.send(`I couldn't DM <@${userId}> about their streak loss. They might have DMs disabled.`);
            }
        }

        if (rolesToRemove.length > 0) {
            await member.roles.remove(rolesToRemove);
        }
    } catch (error) {
        console.error(`Error removing streak roles in guild ${guildId} for user ${userId}: ${error.message}`);
    }
}

// Assign role to user
async function assignRole(guildId, userId, roleId) {
    try {
        const guild = client.guilds.cache.get(guildId);
        const member = guild.members.cache.get(userId);

        if (member && roleId) {
            const role = guild.roles.cache.get(roleId);
            if (role) {
                await member.roles.add(role);
                return role;
            } else {
                console.warn(`Role with ID ${roleId} not found in guild ${guildId}`);
            }
        } else {
            console.warn(`Member with ID ${userId} not found in guild ${guildId}`);
        }
    } catch (error) {
        console.error(`Failed to assign role ${roleId} to user ${userId} in guild ${guildId}: ${error.message}`);
    }
    return null;
}

// Flush cache to disk
async function flushCacheToDisk() {
    try {
        for (const guildId in userMessageCache) {
            if (Object.keys(userMessageCache[guildId]).length === 0) {
                continue;
            }

            const userDbPath = path.join(__dirname, '..', 'databases', guildId, 'userDatabase.json');

            try {
                let userDatabase = {};
                if (await fs.pathExists(userDbPath)) {
                    userDatabase = await loadDatabase(userDbPath);
                }

                for (const userId in userMessageCache[guildId]) {
                    if (!userDatabase[userId]) {
                        userDatabase[userId] = {
                            streak: 0,
                            highestStreak: 0,
                            messages: 0,
                            threshold: 0,
                            receivedDaily: false,
                            messageLeaderWins: 0,
                            highestMessageCount: 0,
                            mostConsecutiveLeader: 0,
                            averageMessagesPerDay: 0,
                            messagesInCurrentWeek: 0,
                        };
                    }
                    userDatabase[userId].messages += userMessageCache[guildId][userId].messages;
                }

                await saveDatabase(userDbPath, userDatabase);

                userMessageCache[guildId] = {};

            } catch (error) {
                console.error(`Failed to flush message count cache to disk for guild ${guildId}: ${error.message}`);
            }
        }
    } catch (error) {
        console.error(`Error during cache flush: ${error.message}`);
    }
}

function setLongTimeout(callback, duration) {
    const maxDuration = 2147483647;
    if (duration > maxDuration) {
        setTimeout(() => {
            setLongTimeout(callback, duration - maxDuration);
        }, maxDuration);
    } else {
        setTimeout(callback, duration);
    }
}

// Schedule resets and reports
function scheduleDailyReset() {
    cron.schedule('0 0 * * *', () => {
        console.log('Running daily streak reset at 12 AM');
        resetDailyStreaks();
    });
}

function scheduleMessageLeaderAnnounce() {
    cron.schedule('0 18 * * 0', () => {
        console.log('Running weekly message leader announcement at 12 AM on Sunday');
        announceMessageLeaders();
    });
}

async function announceMessageLeaders() {
    try {
        const guilds = client.guilds.cache.map(guild => guild.id);

        for (const guildId of guilds) {
            const userDbPath = path.join(__dirname, '..', 'databases', guildId, 'userDatabase.json');
            const configPath = path.join(__dirname, '..', 'databases', guildId, 'config.json');

            if (await fs.pathExists(userDbPath) && await fs.pathExists(configPath)) {
                const userDatabase = await fs.readJson(userDbPath);
                const config = await fs.readJson(configPath);

                if (!config.messageLeaderSystem?.enabled) {
                    continue;
                }

                const currentMembers = await client.guilds.cache.get(guildId).members.fetch();
                const messageLeaders = Object.entries(userDatabase)
                    .filter(([userId, data]) => currentMembers.has(userId) && data.messages > 0)
                    .sort(([, a], [, b]) => b.messages - a.messages)
                    .slice(0, 10);

                if (messageLeaders.length === 0) {
                    continue;
                }

                const top10Users = messageLeaders.map(([userId, data], index) => {
                    const member = client.guilds.cache.get(guildId).members.cache.get(userId);
                    return {
                        top: index + 1,
                        avatar: member ? member.user.displayAvatarURL({ format: 'png' }) : '',
                        tag: member ? member.user.username : 'N/A',
                        score: data.messages,
                    };
                });

                const leaderboardImage = await new canvafy.Top()
                    .setOpacity(0.6)
                    .setScoreMessage("Messages:")
                    .setBackground(
                        'image',
                        'https://img.freepik.com/premium-vector/red-fog-smoke-isolated-transparent-background-red-cloudiness-mist-smog-background-vector-realistic-illustration_221648-615.jpg'
                    )
                    .setColors({
                        box: '#212121',
                        username: '#ffffff',
                        score: '#ffffff',
                        firstRank: '#f7c716',
                        secondRank: '#9e9e9e',
                        thirdRank: '#94610f',
                    })
                    .setUsersData(top10Users)
                    .build();

                const attachment = new AttachmentBuilder(leaderboardImage, { name: `leaderboard-${guildId}.png` });

                const messageLeaderChannelId = config.messageLeaderSystem.channelMessageLeader;
                const messageLeaderChannel = client.guilds.cache.get(guildId).channels.cache.get(messageLeaderChannelId);
                const guildName = client.guilds.cache.get(guildId).name;

                if (!messageLeaderChannel || !messageLeaderChannel.isTextBased()) {
                    console.error(`Message leader channel is not valid or not text-based for guild ${guildId}.`);
                    continue;
                }

                let messageContent = `🎉 **Message Leaders for last week in ${guildName}!** 🔥\n\n`;
                messageContent += `🏆 1st: <@${messageLeaders[0]?.[0] || ''}> (${top10Users[0]?.tag || 'N/A'})\n`;
                messageContent += `🥈 2nd: <@${messageLeaders[1]?.[0] || ''}> (${top10Users[1]?.tag || 'N/A'})\n`;
                messageContent += `🥉 3rd: <@${messageLeaders[2]?.[0] || ''}> (${top10Users[2]?.tag || 'N/A'})\n`;
                messageContent += `🎖️ 4th: <@${messageLeaders[3]?.[0] || ''}> (${top10Users[3]?.tag || 'N/A'})\n`;
                messageContent += `🎖️ 5th: <@${messageLeaders[4]?.[0] || ''}> (${top10Users[4]?.tag || 'N/A'})\n`;
                messageContent += `📜 6th-10th: ${messageLeaders.slice(5).map(([userId], index) => `<@${userId}> (${top10Users[index + 5]?.tag || 'N/A'})`).join(', ')}\n\n`;
                messageContent += `Congratulations to everyone who participated!`;

                try {
                    await messageLeaderChannel.send({
                        content: messageContent,
                        files: [attachment],
                    });
                } catch (error) {
                    console.error(`Failed to send message leaders to guild ${guildId}: ${error.message}`);
                }

                // Assign the Message Leader role to the top 5 users
                const leaderRoleId = config.messageLeaderSystem.roleMessageLeader;
                if (leaderRoleId) {
                    const leaderRole = client.guilds.cache.get(guildId).roles.cache.get(leaderRoleId);

                    if (leaderRole) {
                        // Remove the role from all members to reset for new leaders
                        for (const member of leaderRole.members.values()) {
                            try {
                                await member.roles.remove(leaderRole);
                            } catch (error) {
                                console.error(`Failed to remove leader role from ${member.user.tag} in guild ${guildId}: ${error.message}`);
                            }
                        }

                        // Add the role to the top 5 message leaders
                        for (let i = 0; i < 5; i++) {
                            const userId = messageLeaders[i]?.[0];
                            if (userId) {
                                try {
                                    await assignRole(guildId, userId, leaderRoleId);
                                } catch (error) {
                                    console.error(`Failed to assign leader role to user ${userId} in guild ${guildId}: ${error.message}`);
                                }
                            }
                        }
                    } else {
                        console.error(`Leader role ID ${leaderRoleId} not found in guild ${guildId}`);
                    }
                } else {
                    console.warn(`No leader role configured for guild ${guildId}`);
                }

                // Update message counts and wins
                for (let i = 0; i < 5; i++) {
                    const userId = messageLeaders[i]?.[0];
                    if (userId) {
                        userDatabase[userId].messageLeaderWins = (userDatabase[userId].messageLeaderWins || 0) + 1;
                    }
                }

                // Reset message counts for all users
                for (const userId in userDatabase) {
                    userDatabase[userId].messages = 0;
                }
                await saveDatabase(userDbPath, userDatabase);
            }
        }
    } catch (error) {
        console.error(`Error during message leader announcement: ${error.message}`);
    }
}

async function generateWeeklyReport(guildId) {
    try {
        const configPath = path.join(__dirname, '..', 'databases', guildId, 'config.json');
        const config = await fs.readJson(configPath);
        const userDbPath = path.join(__dirname, '..', 'databases', guildId, 'userDatabase.json');
        const userDatabase = await fs.readJson(userDbPath);

        const reportChannelId = config.reportSettings.weeklyReportChannel;
        const reportChannel = client.guilds.cache.get(guildId).channels.cache.get(reportChannelId);

        if (!reportChannel || !reportChannel.isTextBased()) {
            console.error(`Invalid weekly report channel for guild ${guildId}.`);
            return;
        }

        const totalMessages = Object.values(userDatabase).reduce((acc, userData) => acc + (userData.messages || 0), 0);
        const totalUsers = Object.keys(userDatabase).length;
        const averageMessagesPerUser = (totalMessages / totalUsers).toFixed(2);

        const reportMessage = `**Weekly Report for ${client.guilds.cache.get(guildId).name}**\n\n` +
            `- Total Messages: ${totalMessages}\n` +
            `- Total Active Users: ${totalUsers}\n` +
            `- Average Messages per User: ${averageMessagesPerUser}`;

        await reportChannel.send(reportMessage);
    } catch (error) {
        console.error(`Error generating weekly report for guild ${guildId}: ${error.message}`);
    }
}

async function generateMonthlyReport(guildId) {
    try {
        const configPath = path.join(__dirname, '..', 'databases', guildId, 'config.json');
        const config = await fs.readJson(configPath);
        const userDbPath = path.join(__dirname, '..', 'databases', guildId, 'userDatabase.json');
        const userDatabase = await fs.readJson(userDbPath);

        const reportChannelId = config.reportSettings.monthlyReportChannel;
        const reportChannel = client.guilds.cache.get(guildId).channels.cache.get(reportChannelId);

        if (!reportChannel || !reportChannel.isTextBased()) {
            console.error(`Invalid monthly report channel for guild ${guildId}.`);
            return;
        }

        const totalMessages = Object.values(userDatabase).reduce((acc, userData) => acc + (userData.messages || 0), 0);
        const totalUsers = Object.keys(userDatabase).length;
        const averageMessagesPerUser = (totalMessages / totalUsers).toFixed(2);

        const reportMessage = `**Monthly Report for ${client.guilds.cache.get(guildId).name}**\n\n` +
            `- Total Messages: ${totalMessages}\n` +
            `- Total Active Users: ${totalUsers}\n` +
            `- Average Messages per User: ${averageMessagesPerUser}`;

        await reportChannel.send(reportMessage);
    } catch (error) {
        console.error(`Error generating monthly report for guild ${guildId}: ${error.message}`);
    }
}

function scheduleWeeklyReport() {
    cron.schedule('0 0 * * 0', async () => {
        const guilds = client.guilds.cache.map(guild => guild.id);
        for (const guildId of guilds) {
            await generateWeeklyReport(guildId);
        }
        console.log('Weekly report generated at 12 AM on Sunday');
    });
}

function scheduleMonthlyReport() {
    const monthlyInterval = 30 * 24 * 60 * 60 * 1000;
    const guilds = client.guilds.cache.map(guild => guild.id);

    for (const guildId of guilds) {
        setLongTimeout(async () => {
            await generateMonthlyReport(guildId);
            scheduleMonthlyReport();
        }, monthlyInterval);
    }
}

async function sendConfigMessage(guild) {
    try {
        let targetChannel = null;

        if (guild.publicUpdatesChannelId) {
            targetChannel = guild.channels.cache.get(guild.publicUpdatesChannelId);
        }

        if (!targetChannel && guild.systemChannelId) {
            targetChannel = guild.channels.cache.get(guild.systemChannelId);
        }

        if (!targetChannel) {
            targetChannel = guild.channels.cache.find(channel => channel.isTextBased());
        }

        if (targetChannel) {
            const auditLogs = await guild.fetchAuditLogs({ type: 28, limit: 1 });
            const botAddLog = auditLogs.entries.first();
            const userWhoAddedBot = botAddLog ? botAddLog.executor : null;

            let messageContent = "Hello! To set up the Streak Bot, please use `/setup-bot` to configure the streak system, the message leader system, or both!";
            if (userWhoAddedBot) {
                messageContent = `Hello ${userWhoAddedBot}, to set up the Streak Bot, please use \`/setup-bot\` to configure the streak system, the message leader system, or both!`;
            }
            await targetChannel.send(messageContent);
        }
    } catch (error) {
        console.error(`Failed to send configuration message in guild ${guild.id}: ${error.message}`);
    }
}

client.on('guildMemberRemove', async (member) => {
    const guildId = member.guild.id;
    const userId = member.user.id;

    const userDbPath = path.join(__dirname, '..', 'databases', guildId, 'userDatabase.json');

    try {
        if (await fs.pathExists(userDbPath)) {
            const userDatabase = await fs.readJson(userDbPath);

            if (userDatabase[userId]) {
                delete userDatabase[userId];

                await fs.writeJson(userDbPath, userDatabase, { spaces: 2 });
            }
        }
    } catch (error) {
        console.error(`Error removing user data for user ${userId} in guild ${guildId}: ${error.message}`);
    }
});

client.login(token).catch(console.error);
