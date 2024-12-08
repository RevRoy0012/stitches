const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs-extra');
const path = require('path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('retention')
        .setDescription('View or compare user retention')
        .addSubcommand(subcommand =>
            subcommand
                .setName('view-retention')
                .setDescription('View user retention over a date range')
                .addStringOption(option =>
                    option.setName('start-date')
                        .setDescription('The start date (YYYY-MM-DD)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('end-date')
                        .setDescription('The end date (YYYY-MM-DD)')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('compare-retention')
                .setDescription('Compare user retention between two date ranges')
                .addStringOption(option =>
                    option.setName('start-date-1')
                        .setDescription('The start date for the first range (YYYY-MM-DD)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('end-date-1')
                        .setDescription('The end date for the first range (YYYY-MM-DD)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('start-date-2')
                        .setDescription('The start date for the second range (YYYY-MM-DD)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('end-date-2')
                        .setDescription('The end date for the second range (YYYY-MM-DD)')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const userDbPath = path.join(__dirname, '..', '..', 'databases', guildId, 'userDatabase.json');
        const userDatabase = await fs.readJson(userDbPath);

        const getUsersInRange = (startDate, endDate) => {
            const users = new Set();
            Object.values(userDatabase).forEach(userData => {
                if (Array.isArray(userData.messageHeatmap)) {
                    userData.messageHeatmap.forEach(entry => {
                        const entryDate = new Date(entry.date).toISOString().split('T')[0];
                        if (entryDate >= startDate && entryDate <= endDate) {
                            users.add(userData.userId);
                        }
                    });
                }
            });
            return users;
        };

        if (subcommand === 'view-retention') {
            const startDate = interaction.options.getString('start-date');
            const endDate = interaction.options.getString('end-date');

            const usersInRange = getUsersInRange(startDate, endDate);

            // Since we're viewing a single range, assume retention is 100% (same range being compared)
            const retainedUsers = usersInRange.size;
            const retentionRate = 100;

            const embed = new EmbedBuilder()
                .setTitle('📊 User Retention Report')
                .setDescription(`Here’s the user activity retention data between the selected date range:`)
                .addFields(
                    { name: 'Start Date', value: startDate, inline: true },
                    { name: 'End Date', value: endDate, inline: true },
                    { name: 'Active Users', value: `${usersInRange.size}`, inline: true },
                    { name: 'Retained Users', value: `${retainedUsers}`, inline: true },
                    { name: 'Retention Rate', value: `${retentionRate}%`, inline: true }
                )
                .setColor('#00FF7F')
                .setFooter({ text: 'Retention Analysis', iconURL: interaction.guild.iconURL() })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (subcommand === 'compare-retention') {
            const startDate1 = interaction.options.getString('start-date-1');
            const endDate1 = interaction.options.getString('end-date-1');
            const startDate2 = interaction.options.getString('start-date-2');
            const endDate2 = interaction.options.getString('end-date-2');

            const usersInRange1 = getUsersInRange(startDate1, endDate1);
            const usersInRange2 = getUsersInRange(startDate2, endDate2);

            const retainedUsers = [...usersInRange1].filter(user => usersInRange2.has(user));
            const retentionRate = (retainedUsers.length / usersInRange1.size) * 100;

            const embed = new EmbedBuilder()
                .setTitle('📊 User Retention Comparison')
                .setDescription(`Comparison between the two selected date ranges:`)
                .addFields(
                    { name: 'Date Range 1', value: `${startDate1} - ${endDate1}`, inline: true },
                    { name: 'Active Users (Range 1)', value: `${usersInRange1.size}`, inline: true },
                    { name: 'Date Range 2', value: `${startDate2} - ${endDate2}`, inline: true },
                    { name: 'Active Users (Range 2)', value: `${usersInRange2.size}`, inline: true },
                    { name: 'Retained Users', value: `${retainedUsers.length}`, inline: true },
                    { name: 'Retention Rate', value: `${retentionRate.toFixed(2)}%`, inline: true }
                )
                .setColor('#FFD700')
                .setFooter({ text: 'Retention Comparison', iconURL: interaction.guild.iconURL() })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        }
    }
};
