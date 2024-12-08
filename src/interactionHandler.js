const { Collection } = require('discord.js');
const { StringSelectMenuBuilder, ActionRowBuilder } = require('@discordjs/builders');
const fs = require('fs');
const path = require('path');
const { set } = require('lodash');
const cooldowns = new Collection();

module.exports = async (client, interaction) => {
    try {
        // Handle slash commands
        if (interaction.isCommand()) {
            const command = client.commands.get(interaction.commandName);

            if (!command) {
                return interaction.reply({
                    content: 'This command is no longer available.',
                    ephemeral: true,
                });
            }

            // Cooldown logic
            const now = Date.now();
            const cooldownAmount = 3000;
            const timestamps = cooldowns.get(interaction.user.id);

            if (timestamps) {
                const expirationTime = timestamps + cooldownAmount;
                if (now < expirationTime) {
                    const timeLeft = (expirationTime - now) / 1000;
                    return interaction.reply({
                        content: `Please wait ${timeLeft.toFixed(1)} more second(s) before reusing the \`${interaction.commandName}\` command.`,
                        ephemeral: true,
                    });
                }
            }

            cooldowns.set(interaction.user.id, now);
            setTimeout(() => cooldowns.delete(interaction.user.id), cooldownAmount);

            // Command execution with error handling
            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(`Error executing command ${interaction.commandName}:`, error);
                handleInteractionError(interaction, 'There was an error while executing this command!');
            }
        }
        // Handle select menu interactions
        else if (interaction.isStringSelectMenu()) {
            const { guild, customId } = interaction;

            if (!guild) {
                return interaction.reply({
                    content: "This action is only available within a server (guild).",
                    ephemeral: true,
                });
            }

            // Define paths to your databases and config files
            const configPath = path.join(__dirname, '..', 'databases', `${guild.id}`, 'config.json');
            let config = {};

            // Check if the config exists and read it
            try {
                await fs.promises.access(configPath, fs.constants.F_OK);
                config = await fs.promises.readFile(configPath, 'utf-8').then(JSON.parse);
            } catch (error) {
                return interaction.reply({
                    content: 'Configuration for this guild is missing.',
                    ephemeral: true,
                });
            }

            // Ensure config structure is correct
            ensureConfigStructure(config);

            // Handle specific select menu interactions
            try {
                if (customId === 'system-select') {
                    await handleSystemSelect(interaction, config);
                } else if (customId === 'streak-options') {
                    await handleStreakOptions(interaction, config, guild, configPath);
                } else if (customId === 'leader-options') {
                    await handleLeaderOptions(interaction, config, guild, configPath);
                } else if (customId === 'level-options') {
                    await handleLevelOptions(interaction, config, guild, configPath);
                } else if (customId === 'weeklyReportSystem') {
                    await handleReportOptions(interaction, config, guild, configPath);
                }
            } catch (error) {
                console.error(`Error handling select menu interaction: ${customId}`, error);
                handleInteractionError(interaction, 'There was an error processing your selection.');
            }
        }
    } catch (error) {
        console.error('Critical error handling interaction:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'A critical error occurred. Please try again later.',
                ephemeral: true,
            });
        }
    }
};

// Helper function to handle interaction errors gracefully
async function handleInteractionError(interaction, errorMessage) {
    try {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: errorMessage,
                ephemeral: true,
            });
        } else if (interaction.deferred) {
            await interaction.editReply({
                content: errorMessage,
            });
        }
    } catch (replyError) {
        console.error('Failed to send error reply:', replyError);
    }
}

// Ensure the config structure is valid to avoid issues with missing properties
function ensureConfigStructure(config) {
    if (!config.streakSystem) {
        config.streakSystem = {
            enabled: false,
            streakThreshold: 10,
        };
    }

    if (!config.messageLeaderSystem) {
        config.messageLeaderSystem = {
            enabled: false,
        };
    }

    if (!config.levelSystem) {
        config.levelSystem = {
            enabled: false,
            xpPerMessage: 10,
            levelMultiplier: 1.5,
            rewards: {},
        };
    }

    if (!config.reportSettings) {
        config.reportSettings = {
            weeklyReportChannel: "",
            monthlyReportChannel: ""
        };
    }
}

// Handle system selection menu
async function handleSystemSelect(interaction) {
    const system = interaction.values[0];
    let menu, content;

    if (system === 'streakSystem') {
        menu = new StringSelectMenuBuilder()
            .setCustomId('streak-options')
            .setPlaceholder('Select a streak system option')
            .addOptions([
                { label: 'View Config', value: 'viewStreakConfig' },
                { label: 'Add Milestone', value: 'addMilestone' },
                { label: 'Remove Milestone', value: 'removeMilestone' },
                { label: 'Streak Output Channel', value: 'channelStreakOutput' },
                { label: 'Streak Threshold', value: 'streakThreshold' },
                { label: 'Enable Streak System', value: 'enableStreak' },
                { label: 'Disable Streak System', value: 'disableStreak' },
            ]);
        content = 'Configure the Streak System:';
    } else if (system === 'messageLeaderSystem') {
        menu = new StringSelectMenuBuilder()
            .setCustomId('leader-options')
            .setPlaceholder('Select a message leader system option')
            .addOptions([
                { label: 'View Config', value: 'viewLeaderConfig' },
                { label: 'Message Leader Announcement Channel', value: 'channelMessageLeader' },
                { label: 'Message Leader Winner Role', value: 'roleMessageLeader' },
                { label: 'Enable Message Leader System', value: 'enableLeader' },
                { label: 'Disable Message Leader System', value: 'disableLeader' },
            ]);
        content = 'Configure the Message Leader System:';
    } else if (system === 'levelSystem') {
        menu = new StringSelectMenuBuilder()
            .setCustomId('level-options')
            .setPlaceholder('Select a level system option')
            .addOptions([
                { label: 'View Config', value: 'viewLevelConfig' },
                { label: 'XP per Message', value: 'xpPerMessage' },
                { label: 'XP Increment', value: 'levelMultiplier' },
                { label: 'Level-Up Message Channel', value: 'channelLevelUp' },
                { label: 'Enable Level System', value: 'enableLevel' },
                { label: 'Disable Level System', value: 'disableLevel' },
                { label: 'Add Milestone', value: 'addLevelMilestone' },
                { label: 'Remove Milestone', value: 'removeLevelMilestone' },
            ]);
        content = 'Configure the Level System:';
    } else if (system === 'weeklyReportSystem') {
        menu = new StringSelectMenuBuilder()
            .setCustomId('report-options')
            .setPlaceholder('Select a report system option')
            .addOptions([
                { label: 'View Config', value: 'viewReportConfig' },
                { label: 'Weekly Report Channel', value: 'weeklyReportChannel' },
                { label: 'Monthly Report Channel', value: 'monthlyReportChannel' }
            ]);
    }

    const row = new ActionRowBuilder().addComponents(menu);
    await interaction.update({ content, components: [row] });
}

// Handle streak system options
async function handleStreakOptions(interaction, config, guild, configPath) {
    const option = interaction.values[0];

    if (option === 'viewStreakConfig') {
        await interaction.reply({
            content: `Current Streak System Config:\nEnabled: ${config.streakSystem.enabled}\nThreshold: ${config.streakSystem.streakThreshold}\nMilestones: ${Object.keys(config.streakSystem)
                .filter(key => key.startsWith('role') && key.endsWith('day'))
                .map(key => `${key.replace('role', '').replace('day', '')} days`)
                .join(', ')}`,
            ephemeral: true,
        });
    } else if (option === 'addMilestone') {
        await addMilestone(interaction, guild, config, configPath, 'streak');
    } else if (option === 'removeMilestone') {
        await removeMilestone(interaction, guild, config, configPath, 'streak');
    } else if (option === 'enableStreak' || option === 'disableStreak') {
        config.streakSystem.enabled = option === 'enableStreak';
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
        await interaction.update({ content: `Streak System has been ${option === 'enableStreak' ? 'enabled' : 'disabled'}.`, components: [] });
    } else if (option === 'channelStreakOutput') {
        await setChannel(interaction, guild, config, configPath, 'streakSystem.channelStreakOutput', 'Streak Output Channel');
    } else if (option === 'streakThreshold') {
        await setThreshold(interaction, config, configPath, 'streakSystem.streakThreshold', 'Streak threshold');
    }
}

// Handle message leader system options
async function handleLeaderOptions(interaction, config, guild, configPath) {
    const option = interaction.values[0];

    if (option === 'viewLeaderConfig') {
        await interaction.reply({
            content: `Current Message Leader System Config:\nEnabled: ${config.messageLeaderSystem.enabled}\nAnnouncement Channel: <#${config.messageLeaderSystem.channelMessageLeader || 'Not Set'}>\nWinner Role: <@&${config.messageLeaderSystem.roleMessageLeader || 'Not Set'}>`,
            ephemeral: true,
        });
    } else if (option === 'enableLeader' || option === 'disableLeader') {
        config.messageLeaderSystem.enabled = option === 'enableLeader';
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
        await interaction.update({ content: `Message Leader System has been ${option === 'enableLeader' ? 'enabled' : 'disabled'}.`, components: [] });
    } else if (option === 'channelMessageLeader') {
        await setChannel(interaction, guild, config, configPath, 'messageLeaderSystem.channelMessageLeader', 'Message Leader Announcement Channel');
    } else if (option === 'roleMessageLeader') {
        await setRole(interaction, guild, config, configPath, 'messageLeaderSystem.roleMessageLeader', 'Message Leader Role');
    }
}

// Handle level system options
async function handleLevelOptions(interaction, config, guild, configPath) {
    const option = interaction.values[0];

    if (option === 'viewLevelConfig') {
        await interaction.reply({
            content: `Current Level System Config:\nEnabled: ${config.levelSystem.enabled}\nXP per Message: ${config.levelSystem.xpPerMessage}\nXP Increment: ${config.levelSystem.levelMultiplier}\nLevel-Up Message Channel: <#${config.levelSystem.channelLevelUp || 'Not Set'}>\nMilestones: ${Object.keys(config.levelSystem)
                .filter(key => key.startsWith('role') && key.startsWith('Level'))
                .map(key => `${key.replace('role', '').replace('Level', '')} Level`)
                .join(', ')}`,
            ephemeral: true,
        });
    } else if (option === 'enableLevel' || option === 'disableLevel') {
        config.levelSystem.enabled = option === 'enableLevel';
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
        await interaction.update({ content: `Level System has been ${option === 'enableLevel' ? 'enabled' : 'disabled'}.`, components: [] });
    } else if (option === 'xpPerMessage') {
        await setThreshold(interaction, config, configPath, 'levelSystem.xpPerMessage', 'XP per message');
    } else if (option === 'levelMultiplier') {
        await setThreshold(interaction, config, configPath, 'levelSystem.levelMultiplier', 'XP increment per level');
    } else if (option === 'channelLevelUp') {
        await setChannel(interaction, guild, config, configPath, 'levelSystem.channelLevelUp', 'Level-Up Message Channel');
    } else if (option === 'addLevelMilestone') {
        await addMilestone(interaction, guild, config, configPath, 'level');
    } else if (option === 'removeLevelMilestone') {
        await removeMilestone(interaction, guild, config, configPath, 'level');
    }
}

// Handle report system options
async function handleReportOptions(interaction, config, guild, configPath) {
    const option = interaction.values[0];

    if (option === 'viewReportConfig') {
        await interaction.reply({
            content: `Current Report Settings:\nWeekly Report Channel: <#${config.reportSettings.weeklyReportChannel || 'Not Set'}>\nMonthly Report Channel: <#${config.reportSettings.monthlyReportChannel || 'Not Set'}>`,
            ephemeral: true,
        });
    } else if (option === 'weeklyReportChannel') {
        await setChannel(interaction, guild, config, configPath, 'reportSettings.weeklyReportChannel', 'Weekly Report Channel');
    } else if (option === 'monthlyReportChannel') {
        await setChannel(interaction, guild, config, configPath, 'reportSettings.monthlyReportChannel', 'Monthly Report Channel');
    }
}


// Helper functions for setting channels, roles, and thresholds
async function setChannel(interaction, guild, config, configPath, configKey, description) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.followUp({ content: `Please mention the channel for ${description} (e.g., #channel-name):` });

    const filter = (msg) => msg.author.id === interaction.user.id && msg.guild.id === guild.id;
    const collector = interaction.channel.createMessageCollector({ filter, time: 15000, max: 1 });

    collector.on('collect', async (msg) => {
        const channel = msg.mentions.channels.first();
        await msg.delete();

        if (!channel || !channel.isTextBased()) {
            await interaction.followUp({ content: 'Please mention a valid text channel.', ephemeral: true });
        } else {
            // Use lodash.set to safely set nested keys
            set(config, configKey, channel.id);
            await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
            await interaction.followUp({ content: `${description} has been set to ${channel.name}.`, ephemeral: true });
        }
    });

    collector.on('end', (collected) => {
        if (collected.size === 0) {
            interaction.followUp({ content: 'Time ran out. Please try the command again.', ephemeral: true });
        }
    });
}

async function setThreshold(interaction, config, configPath, configKey, description) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.followUp({ content: `Please enter the ${description}:` });

    const filter = (msg) => msg.author.id === interaction.user.id && msg.guild.id === guild.id;
    const collector = interaction.channel.createMessageCollector({ filter, time: 15000, max: 1 });

    collector.on('collect', async (msg) => {
        const value = parseInt(msg.content, 10);
        await msg.delete();

        if (isNaN(value) || value <= 0) {
            await interaction.followUp({ content: 'Please provide a valid number.', ephemeral: true });
        } else {
            // Use lodash.set to safely set nested keys
            set(config, configKey, value);
            await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
            await interaction.followUp({ content: `${description} has been set to ${value}.`, ephemeral: true });
        }
    });

    collector.on('end', (collected) => {
        if (collected.size === 0) {
            interaction.followUp({ content: 'Time ran out. Please try the command again.', ephemeral: true });
        }
    });
}

async function setRole(interaction, guild, config, configPath, configKey, description) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.followUp({ content: `Please mention the role for ${description} (e.g., @role-name):` });

    const filter = (msg) => msg.author.id === interaction.user.id && msg.guild.id === guild.id;
    const collector = interaction.channel.createMessageCollector({ filter, time: 15000, max: 1 });

    collector.on('collect', async (msg) => {
        const role = msg.mentions.roles.first();
        await msg.delete();

        if (!role) {
            await interaction.followUp({ content: 'Please mention a valid role.', ephemeral: true });
        } else {
            // Use lodash.set to safely set nested keys
            set(config, configKey, role.id);
            await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
            await interaction.followUp({ content: `${description} has been set to ${role.name}.`, ephemeral: true });
        }
    });

    collector.on('end', (collected) => {
        if (collected.size === 0) {
            interaction.followUp({ content: 'Time ran out. Please try the command again.', ephemeral: true });
        }
    });
}

async function addMilestone(interaction, guild, config, configPath, systemType) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.followUp({ content: `Please enter the number of days/level for the milestone (e.g., 5 for 5-day streak or Level 5):` });

    const filter = (msg) => msg.author.id === interaction.user.id && msg.guild.id === guild.id;
    const collector = interaction.channel.createMessageCollector({ filter, time: 15000, max: 1 });

    collector.on('collect', async (msg) => {
        const milestone = parseInt(msg.content, 10);
        await msg.delete();

        if (isNaN(milestone) || milestone <= 0) {
            await interaction.followUp({ content: 'Please provide a valid number.', ephemeral: true });
        } else {
            const roleName = systemType === 'streak' ? `${milestone} Day Streak` : `Level ${milestone}`;
            let milestoneRole = guild.roles.cache.find(role => role.name === roleName);

            if (!milestoneRole) {
                milestoneRole = await guild.roles.create({
                    name: roleName,
                    color: '#00FF00', // Green color for streak/level roles
                    reason: `Role for users with a ${milestone}-day streak or reaching Level ${milestone}`,
                });
            }

            config[systemType === 'streak' ? `streakSystem` : `levelSystem`][`role${milestone}${systemType === 'streak' ? 'day' : ''}`] = milestoneRole.id;
            await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

            // Assign the milestone role to existing users
            const userDbPath = path.join(__dirname, '..', 'databases', guild.id, 'userDatabase.json');
            let userDatabase = {};

            if (await fs.promises.access(userDbPath, fs.constants.F_OK)) {
                userDatabase = await fs.promises.readFile(userDbPath, 'utf-8').then(JSON.parse);
            }

            for (const [userId, userData] of Object.entries(userDatabase)) {
                if (
                    (systemType === 'streak' && userData.streak >= milestone) ||
                    (systemType === 'level' && userData.experience.level >= milestone)
                ) {
                    if (!guild.members.cache.get(userId).roles.cache.has(milestoneRole.id)) {
                        await assignRole(guild.id, userId, milestoneRole.id);
                    }
                }
            }

            await interaction.followUp({
                content: `Milestone for ${milestone} ${systemType === 'streak' ? 'days' : 'level'} has been added and roles assigned to those who have met the criteria.`,
                ephemeral: true,
            });
        }
    });

    collector.on('end', (collected) => {
        if (collected.size === 0) {
            interaction.followUp({ content: 'Time ran out. Please try the command again.', ephemeral: true });
        }
    });
}

async function removeMilestone(interaction, guild, config, configPath, systemType) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.followUp({ content: `Please enter the number of days/level for the milestone to remove:` });

    const filter = (msg) => msg.author.id === interaction.user.id && msg.guild.id === guild.id;
    const collector = interaction.channel.createMessageCollector({ filter, time: 15000, max: 1 });

    collector.on('collect', async (msg) => {
        const milestone = parseInt(msg.content, 10);
        await msg.delete();

        if (isNaN(milestone) || milestone <= 0) {
            await interaction.followUp({ content: 'Please provide a valid number.', ephemeral: true });
        } else {
            const roleKey = systemType === 'streak' ? `role${milestone}day` : `roleLevel${milestone}`;
            const milestoneRoleId = config[systemType === 'streak' ? 'streakSystem' : 'levelSystem'][roleKey];

            if (!milestoneRoleId) {
                return interaction.followUp({ content: `No milestone for ${milestone} ${systemType === 'streak' ? 'days' : 'level'} found.`, ephemeral: true });
            }

            const milestoneRole = guild.roles.cache.get(milestoneRoleId);
            if (milestoneRole) {
                await milestoneRole.delete();
            }

            delete config[systemType === 'streak' ? 'streakSystem' : 'levelSystem'][roleKey];
            await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
            await interaction.followUp({
                content: `Milestone for ${milestone} ${systemType === 'streak' ? 'days' : 'level'} has been removed.`,
                ephemeral: true,
            });
        }
    });

    collector.on('end', (collected) => {
        if (collected.size === 0) {
            interaction.followUp({ content: 'Time ran out. Please try the command again.', ephemeral: true });
        }
    });
}

async function assignRole(guildId, userId, roleId) {
    const guild = client.guilds.cache.get(guildId);
    const member = await guild.members.fetch(userId);
    if (member && roleId && !member.roles.cache.has(roleId)) {
        await member.roles.add(roleId);
    }
}
