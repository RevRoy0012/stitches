const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..', '..');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('edit-user-data')
        .setDescription('Edit a user\'s data (message count, streak, threshold, receivedDaily, XP, level, etc.).')
        .addUserOption(option =>
            option.setName('target')
                .setDescription('Select the user to edit')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('field')
                .setDescription('Field to edit')
                .setRequired(true)
                .addChoices(
                    { name: 'Message Count', value: 'messages' },
                    { name: 'Streak Count', value: 'streak' },
                    { name: 'Threshold', value: 'threshold' },
                    { name: 'Received Daily', value: 'receivedDaily' },
                    { name: 'Level', value: 'level' },
                    { name: 'Active Days Count', value: 'activeDaysCount' }
                ))
        .addStringOption(option =>
            option.setName('value')
                .setDescription('New value for the field')
                .setRequired(true)),

    async execute(interaction) {
        try {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            const targetUser = interaction.options.getUser('target');
            const targetUserId = targetUser.id;
            const field = interaction.options.getString('field');
            const value = interaction.options.getString('value');
            const guildId = interaction.guild.id;
            const client = interaction.client;

            const userDbPath = path.join(projectRoot, 'databases', guildId, 'userDatabase.json');
            const configPath = path.join(projectRoot, 'databases', guildId, 'config.json');

            let userDatabase;
            let config;

            try {
                await fs.promises.access(userDbPath, fs.constants.F_OK);
                userDatabase = await fs.promises.readFile(userDbPath, 'utf-8').then(JSON.parse);
                config = await fs.promises.readFile(configPath, 'utf-8').then(JSON.parse);
            } catch (err) {
                return interaction.reply({ content: 'No user data found for this guild.', ephemeral: true });
            }

            if (!userDatabase[targetUserId]) {
                userDatabase[targetUserId] = {
                    messages: 0,
                    streak: 0,
                    highestStreak: 0,
                    threshold: config.streakSystem.streakThreshold || 10,
                    receivedDaily: false,
                    experience: { totalXp: 0, level: 0 },
                    activeDaysCount: 0,
                    longestInactivePeriod: 0,
                    messageHeatmap: []
                };
                console.log(`User ${targetUser.username} was not found in the database and was initialized.`);
            }


            switch (field) {
                case 'messages':
                case 'streak':
                case 'totalXp':
                case 'level':
                case 'activeDaysCount':
                case 'longestInactivePeriod':
                    if (isNaN(value) || parseInt(value, 10) < 0) {
                        return interaction.reply({ content: 'Please enter a valid number for this field.', ephemeral: true });
                    }
                    break;
                case 'threshold':
                    if (isNaN(value) || parseInt(value, 10) < 0 || parseInt(value, 10) > config.streakSystem.streakThreshold) {
                        return interaction.reply({ content: `Please enter a valid number for the threshold, not exceeding the configured threshold (${config.streakSystem.streakThreshold}).`, ephemeral: true });
                    }
                    break;
                case 'receivedDaily':
                    if (value.toLowerCase() !== 'true' && value.toLowerCase() !== 'false') {
                        return interaction.reply({ content: 'Please enter either "true" or "false" for the receivedDaily field.', ephemeral: true });
                    }
                    break;
                default:
                    return interaction.reply({ content: 'Invalid field specified.', ephemeral: true });
            }

            switch (field) {
                case 'messages':
                    userDatabase[targetUserId].messages = parseInt(value, 10);
                    break;
                case 'streak':
                    const newStreak = parseInt(value, 10);
                    const oldStreak = userDatabase[targetUserId].streak;
                    userDatabase[targetUserId].streak = newStreak;

                    if (newStreak > userDatabase[targetUserId].highestStreak) {
                        userDatabase[targetUserId].highestStreak = newStreak;
                    }

                    console.log(`Streak for user ${targetUser.username} updated from ${oldStreak} to ${newStreak}.`);

                    if (oldStreak > 0) {
                        const oldStreakRoleKey = `role${oldStreak}day`;
                        const oldStreakRole = config.streakSystem[oldStreakRoleKey];
                        if (oldStreakRole) {
                            await removeRole(client, interaction.guild.id, targetUserId, oldStreakRole);
                        }
                    }

                    for (let streakDay = oldStreak + 1; streakDay <= newStreak; streakDay++) {
                        const streakRoleKey = `role${streakDay}day`;
                        const streakRole = config.streakSystem[streakRoleKey];
                        if (streakRole) {
                            await assignRole(client, interaction.guild.id, targetUserId, streakRole);
                        }
                    }
                    break;

                case 'threshold':
                    userDatabase[targetUserId].threshold = parseInt(value, 10);
                    userDatabase[targetUserId].receivedDaily = false;
                    console.log(`Threshold for user ${targetUser.username} updated to ${value} and receivedDaily set to false.`);
                    break;

                case 'receivedDaily':
                    userDatabase[targetUserId].receivedDaily = value.toLowerCase() === 'true';
                    break;

                case 'totalXp':
                    userDatabase[targetUserId].experience.totalXp = parseInt(value, 10);
                    break;

                case 'level':
                    const newLevel = parseInt(value, 10);
                    const oldLevel = userDatabase[targetUserId].experience.level;
                    userDatabase[targetUserId].experience.level = newLevel;

                    const xpRequired = Math.floor(100 * Math.pow(config.levelSystem.levelMultiplier, newLevel));
                    userDatabase[targetUserId].experience.totalXp = Math.min(userDatabase[targetUserId].experience.totalXp, xpRequired - 1);

                    if (oldLevel > 0) {
                        const oldLevelRoleKey = `roleLevel${oldLevel}`;
                        const oldLevelRole = config.levelSystem[oldLevelRoleKey];
                        if (oldLevelRole) {
                            await removeRole(client, interaction.guild.id, targetUserId, oldLevelRole);
                        }
                    }

                    for (let lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
                        const levelRoleKey = `roleLevel${lvl}`;
                        const levelRole = config.levelSystem[levelRoleKey];
                        if (levelRole) {
                            await assignRole(client, interaction.guild.id, targetUserId, levelRole);
                        }
                    }
                    break;

                case 'activeDaysCount':
                    userDatabase[targetUserId].activeDaysCount = parseInt(value, 10);
                    break;

                case 'longestInactivePeriod':
                    userDatabase[targetUserId].longestInactivePeriod = parseInt(value, 10);
                    break;

                default:
                    return interaction.reply({ content: 'Invalid field specified.', ephemeral: true });
            }

            console.log(`Final user data for ${targetUser.username}:`, userDatabase[targetUserId]);

            await fs.promises.writeFile(userDbPath, JSON.stringify(userDatabase, null, 2), 'utf-8');
            await interaction.reply({ content: `Successfully updated ${field} for ${targetUser.username}.`, ephemeral: true });
        } catch (error) {
            console.error(`Error updating user data: ${error}`);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'An error occurred while updating user data.', ephemeral: true });
            }
        }
    }
};

async function assignRole(client, guildId, userId, roleId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const member = await guild.members.fetch(userId);
    if (!member) return;

    const role = guild.roles.cache.get(roleId);
    if (role) {
        await member.roles.add(role);
        console.log(`Assigned role ${roleId} to user ${userId} in guild ${guildId}`);
    } else {
        console.error(`Role ${roleId} not found in guild ${guildId}`);
    }
}

async function removeRole(client, guildId, userId, roleId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const member = await guild.members.fetch(userId);
    if (!member) return;

    const role = guild.roles.cache.get(roleId);
    if (role && member.roles.cache.has(roleId)) {
        await member.roles.remove(role);
        console.log(`Removed role ${roleId} from user ${userId} in guild ${guildId}`);
    } else {
        console.error(`Role ${roleId} not found or user ${userId} does not have it in guild ${guildId}`);
    }
}
